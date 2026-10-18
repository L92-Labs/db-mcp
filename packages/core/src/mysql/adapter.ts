import mysql from "mysql2/promise";
import type { ConnectionOptions, FieldPacket, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { likePattern, toJsonValue } from "../format.js";
import { columnHidden, policyFor, schemaAllowed } from "../policy.js";
import { classAllowed, qualifierTokens, splitStatements } from "../sql/classify.js";
import type {
  ColumnMeta,
  DbAdapter,
  MySqlConnection,
  QueryResult,
  SqlParams,
  StatementClass,
  TableRef,
} from "../types.js";

/** The subset of a mysql2/promise connection the adapter uses (Connection and PoolConnection both fit). */
/** Event-emitting query of the underlying (non-promise) mysql2 connection, used to stream rows. */
type CoreQuery = {
  on(event: "fields", cb: (fields: FieldPacket[]) => void): CoreQuery;
  on(event: "result", cb: (row: unknown) => void): CoreQuery;
  on(event: "error", cb: (error: Error) => void): CoreQuery;
  on(event: "end", cb: () => void): CoreQuery;
};

export type MySqlClient = {
  query(options: { sql: string; values?: unknown[]; timeout?: number }): Promise<[unknown, FieldPacket[]]>;
  /** mysql2/promise exposes the callback connection here (Connection and PoolConnection). */
  connection: {
    query(options: { sql: string; values?: unknown[]; timeout?: number }): unknown;
    destroy(): void;
  };
};

export type MySqlLease = {
  client: MySqlClient;
  /** Pass the error when the connection may be broken so pools can discard it. */
  release: (error?: Error) => Promise<void> | void;
};

export type MySqlConnector = () => Promise<MySqlLease>;

/** Options shared by Node pools and per-request Worker connections. */
export function mysqlClientOptions(
  connection: MySqlConnection,
  target: { uri: string } | { host: string; port: number; user: string; password: string; database: string },
  opts: { disableEval?: boolean } = {},
): ConnectionOptions {
  const ssl =
    connection.ssl === undefined || connection.ssl === false
      ? undefined
      : connection.ssl === "no-verify"
        ? { rejectUnauthorized: false }
        : { rejectUnauthorized: true };
  return {
    ...target,
    ssl,
    // Server text for dates/decimals/bigints: no local-TZ shifting, no precision loss.
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    decimalNumbers: false,
    // One statement per call, always.
    multipleStatements: false,
    // Workers forbid eval/new Function; mysql2 ≥ 3.13 has an interpreter fallback.
    disableEval: opts.disableEval,
    connectAttributes: { program_name: "db-mcp" },
  };
}

const SYSTEM_SCHEMAS = ["mysql", "information_schema", "performance_schema", "sys"];

const TYPE_NAMES: Record<number, string> = Object.fromEntries(
  Object.entries((mysql as unknown as { Types: Record<string, unknown> }).Types ?? {})
    .filter(([, v]) => typeof v === "number")
    .map(([k, v]) => [v as number, k]),
);

export function quoteMySqlIdent(name: string): string {
  return `\`${name.replace(/`/g, "``")}\``;
}

function asArrayParams(params: SqlParams | undefined): unknown[] | undefined {
  if (params === undefined) return undefined;
  if (!Array.isArray(params)) throw new Error("mysql params must be an array bound to ?");
  return params;
}

const KIND_SQL = `CASE t.TABLE_TYPE WHEN 'BASE TABLE' THEN 'table' WHEN 'VIEW' THEN 'view'
  WHEN 'SYSTEM VIEW' THEN 'system_view' ELSE LOWER(t.TABLE_TYPE) END`;

export function createMySqlAdapter(
  connection: MySqlConnection,
  opts: { connect: MySqlConnector },
): DbAdapter {
  const policy = policyFor(connection);
  let timeoutVar: "max_execution_time" | "max_statement_time" | null | undefined;
  let knownSchemas: Set<string> | undefined;

  async function withClient<T>(fn: (client: MySqlClient, discard: () => void) => Promise<T>): Promise<T> {
    const lease = await opts.connect();
    let broken: Error | undefined;
    try {
      return await fn(lease.client, () => {
        broken = new Error("connection discarded after a truncated result");
      });
    } catch (error) {
      broken = error instanceof Error ? error : new Error(String(error));
      throw error;
    } finally {
      await lease.release(broken);
    }
  }

  async function q<R = RowDataPacket[]>(
    client: MySqlClient,
    sql: string,
    values?: unknown[],
    timeout?: number,
  ): Promise<[R, FieldPacket[]]> {
    return (await client.query({ sql, values, timeout })) as [R, FieldPacket[]];
  }

  /** Server-side statement timeout: MySQL max_execution_time (ms, SELECT only) or MariaDB max_statement_time (s). */
  async function setTimeoutVar(client: MySqlClient, ms: number): Promise<void> {
    if (timeoutVar === null) return;
    const attempts: Array<["max_execution_time" | "max_statement_time", string]> = [
      ["max_execution_time", String(Math.floor(ms))],
      ["max_statement_time", (ms / 1000).toFixed(3)],
    ];
    for (const [name, value] of attempts) {
      if (timeoutVar && timeoutVar !== name) continue;
      try {
        await q(client, `SET SESSION ${name} = ${value}`);
        timeoutVar = name;
        return;
      } catch {
        // try the other dialect
      }
    }
    timeoutVar = null;
  }

  /**
   * The lexer assumes MySQL's default quoting: "…" is a string and backslashes escape.
   * Strip ANSI_QUOTES / NO_BACKSLASH_ESCAPES so the server parses SQL the way we checked it.
   */
  async function pinSqlMode(client: MySqlClient): Promise<void> {
    const [[row]] = await q<RowDataPacket[]>(client, "SELECT @@SESSION.sql_mode AS mode");
    const modes = String(row?.mode ?? "")
      .split(",")
      .filter(Boolean);
    const kept = modes.filter((m) => m !== "ANSI_QUOTES" && m !== "NO_BACKSLASH_ESCAPES" && m !== "ANSI");
    if (kept.length !== modes.length) await q(client, "SET SESSION sql_mode = ?", [kept.join(",")]);
  }

  async function prepareSession(
    client: MySqlClient,
    timeoutMs: number,
    rowCap: number | null,
  ): Promise<void> {
    await pinSqlMode(client);
    await setTimeoutVar(client, timeoutMs);
    if (rowCap !== null) await q(client, `SET SESSION sql_select_limit = ${Math.floor(rowCap)}`);
  }

  /**
   * Stream rows and stop after `cap`: an explicit `LIMIT 100000000` overrides sql_select_limit,
   * so the client must not buffer the whole result. Stopping destroys the connection.
   */
  function streamQuery(
    client: MySqlClient,
    sql: string,
    values: unknown[] | undefined,
    cap: number,
    timeout: number,
    onFields: (fields: FieldPacket[]) => void,
  ): Promise<{ raw: unknown; fields: FieldPacket[] | undefined; aborted: boolean }> {
    return new Promise((resolve, reject) => {
      const rows: unknown[] = [];
      let fields: FieldPacket[] | undefined;
      let header: unknown;
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        fn();
      };
      (client.connection.query({ sql, values, timeout }) as CoreQuery)
        .on("fields", (f) => {
          if (!Array.isArray(f)) return; // OK packets (DML) report no columns
          fields = f;
          try {
            onFields(f);
          } catch (error) {
            client.connection.destroy();
            finish(() => reject(error));
          }
        })
        .on("result", (row) => {
          if (settled) return;
          if (!fields) {
            header = row; // OK packet (DML) — no result set
            return;
          }
          rows.push(row);
          if (rows.length >= cap) {
            client.connection.destroy();
            finish(() => resolve({ raw: rows, fields, aborted: true }));
          }
        })
        .on("error", (error) => finish(() => reject(error)))
        .on("end", () => finish(() => resolve({ raw: fields ? rows : header, fields, aborted: false })));
    });
  }

  /**
   * START TRANSACTION READ ONLY (or read-write) with a row cap via sql_select_limit,
   * which bounds what the server sends without rewriting the query.
   */
  async function inTransaction<T>(
    mode: "read" | "write" | "dry_run",
    timeoutMs: number,
    rowCap: number | null,
    fn: (client: MySqlClient) => Promise<T>,
  ): Promise<T> {
    return withClient(async (client) => {
      await prepareSession(client, timeoutMs, rowCap);
      await q(client, mode === "read" ? "START TRANSACTION READ ONLY" : "START TRANSACTION");
      try {
        const out = await fn(client);
        await q(client, mode === "write" ? "COMMIT" : "ROLLBACK");
        return out;
      } catch (error) {
        await q(client, "ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        if (rowCap !== null) await q(client, "SET SESSION sql_select_limit = DEFAULT").catch(() => undefined);
      }
    });
  }

  async function metaQuery<R extends Record<string, unknown>>(
    client: MySqlClient,
    sql: string,
    values: unknown[] = [],
  ): Promise<R[]> {
    const [rows] = await q<RowDataPacket[]>(client, sql, values);
    return rows.map((r) => toJsonValue({ ...r }) as R);
  }

  function meta<R extends Record<string, unknown>>(sql: string, values: unknown[] = []): Promise<R[]> {
    return inTransaction("read", 15_000, null, (client) => metaQuery<R>(client, sql, values));
  }

  async function schemaSet(client: MySqlClient): Promise<Set<string>> {
    if (!knownSchemas) {
      const rows = await metaQuery<{ name: string }>(
        client,
        "SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA",
      );
      knownSchemas = new Set(rows.map((r) => r.name.toLowerCase()));
    }
    return knownSchemas;
  }

  /** Before running: default database and every schema-qualified name must be allowed. */
  async function enforceSql(client: MySqlClient, sql: string): Promise<void> {
    if (!policy?.schemas) return;
    const [[row]] = await q<RowDataPacket[]>(client, "SELECT DATABASE() AS db");
    const current = row?.db as string | null;
    if (current && !schemaAllowed(policy, current)) {
      throw new Error(
        `default database "${current}" is outside the allowlist of connection "${connection.name}"`,
      );
    }
    const known = await schemaSet(client);
    for (const qualifier of splitStatements(sql, "mysql").flatMap(qualifierTokens)) {
      if (known.has(qualifier.toLowerCase()) && !schemaAllowed(policy, qualifier)) {
        throw new Error(`schema ${qualifier} is outside the allowlist of connection "${connection.name}"`);
      }
    }
  }

  /** After running (before COMMIT): result columns must come from allowed schemas and not be hidden. */
  function enforceFields(fields: FieldPacket[]): void {
    if (!policy) return;
    for (const f of fields) {
      const db = f.db || f.schema;
      if (db && !schemaAllowed(policy, db)) {
        throw new Error(
          `result column ${f.name} comes from schema "${db}", outside the allowlist of connection "${connection.name}"`,
        );
      }
      const column = f.orgName || f.name;
      if (columnHidden(policy, { schema: db, table: f.orgTable || null, column })) {
        throw new Error(
          `column ${f.orgTable ? `${f.orgTable}.` : ""}${column} is hidden on connection "${connection.name}"`,
        );
      }
    }
  }

  function columns(fields: FieldPacket[] | undefined): ColumnMeta[] {
    return (fields ?? []).map((f) => ({
      name: f.name,
      type: (
        f.typeName ??
        TYPE_NAMES[f.columnType ?? f.type ?? -1] ??
        `type:${f.columnType ?? f.type}`
      ).toLowerCase(),
    }));
  }

  function shape(
    raw: unknown,
    fields: FieldPacket[] | undefined,
    maxRows: number,
    cls: StatementClass,
    extra: Partial<QueryResult>,
  ): QueryResult {
    if (!Array.isArray(raw)) {
      const header = raw as ResultSetHeader;
      return {
        columns: [],
        rows: [],
        row_count: 0,
        truncated: false,
        statement_class: cls,
        affected_rows: header.affectedRows ?? null,
        ...(header.insertId ? { insert_id: header.insertId } : {}),
        ...extra,
      };
    }
    const rows = raw as RowDataPacket[];
    const truncated = rows.length > maxRows;
    const kept = truncated ? rows.slice(0, maxRows) : rows;
    return {
      columns: columns(fields),
      rows: kept.map((r) => toJsonValue({ ...r }) as Record<string, unknown>),
      row_count: kept.length,
      truncated,
      statement_class: cls,
      ...extra,
    };
  }

  /** One statement in its own transaction, rows streamed and capped (connection dropped when capped). */
  async function runStatement(
    mode: "read" | "write" | "dry_run",
    sql: string,
    values: unknown[] | undefined,
    maxRows: number,
    timeoutMs: number,
    cls: StatementClass,
    extra: Partial<QueryResult> = {},
  ): Promise<QueryResult> {
    const started = Date.now();
    return withClient(async (client, discard) => {
      await prepareSession(client, timeoutMs, maxRows + 1);
      await q(client, mode === "read" ? "START TRANSACTION READ ONLY" : "START TRANSACTION");
      let open = true;
      try {
        await enforceSql(client, sql);
        // Writes are never cut short: stopping early would roll back a statement the caller expects committed.
        const cap = cls === "read" ? maxRows + 1 : Number.POSITIVE_INFINITY;
        const res = await streamQuery(client, sql, values, cap, timeoutMs + 5_000, (fields) =>
          enforceFields(fields),
        );
        if (res.aborted) {
          open = false; // destroyed: the server rolls the transaction back
          discard();
        } else {
          await q(client, mode === "write" ? "COMMIT" : "ROLLBACK");
          open = false;
        }
        return shape(res.raw, res.fields, maxRows, cls, { ...extra, duration_ms: Date.now() - started });
      } finally {
        if (open) await q(client, "ROLLBACK").catch(() => undefined);
        await q(client, "SET SESSION sql_select_limit = DEFAULT").catch(() => undefined);
      }
    });
  }

  function readQuery(sql: string, values: unknown[] | undefined, maxRows: number, timeoutMs: number) {
    return runStatement("read", sql, values, maxRows, timeoutMs, "read");
  }

  async function resolveTable(client: MySqlClient, ref: TableRef) {
    const rows = await metaQuery<{
      schema: string;
      name: string;
      type: string;
      rows: number | null;
      comment: string;
    }>(
      client,
      `SELECT t.TABLE_SCHEMA AS \`schema\`, t.TABLE_NAME AS name, t.TABLE_TYPE AS type, t.TABLE_ROWS AS \`rows\`,
         t.TABLE_COMMENT AS comment, t.TABLE_SCHEMA = DATABASE() AS current_db, t.TABLE_NAME = ? AS exact
       FROM information_schema.TABLES t
       WHERE LOWER(t.TABLE_NAME) = LOWER(?) AND (? IS NULL OR LOWER(t.TABLE_SCHEMA) = LOWER(?))
       ORDER BY exact DESC, current_db DESC, t.TABLE_SCHEMA`,
      [ref.table, ref.table, ref.schema ?? null, ref.schema ?? null],
    );
    const label = ref.schema ? `${ref.schema}.${ref.table}` : ref.table;
    if (rows.length === 0) throw new Error(`table or view not found: ${label}`);
    const best = rows[0]! as (typeof rows)[number] & { current_db: number };
    if (!ref.schema && rows.length > 1 && !best.current_db) {
      throw new Error(
        `"${ref.table}" is ambiguous; pass schema. Candidates: ${rows.map((r) => `${r.schema}.${r.name}`).join(", ")}`,
      );
    }
    return best;
  }

  async function tableColumns(client: MySqlClient, schema: string, table: string) {
    return metaQuery<{ name: string }>(
      client,
      `SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
      [schema, table],
    );
  }

  return {
    engine: "mysql",

    async info() {
      const [row] = await meta(
        `SELECT VERSION() AS version, DATABASE() AS \`database\`, CURRENT_USER() AS \`user\`,
           @@global.read_only AS server_read_only, @@version_comment AS distribution`,
      );
      return {
        via: connection.hyperdrive ? `hyperdrive:${connection.hyperdrive}` : "url",
        ...row,
        enforcement:
          "sql_query runs in START TRANSACTION READ ONLY with sql_select_limit; DDL is refused by the classifier (MySQL DDL commits implicitly), so use a read-only user for defense in depth",
      };
    },

    async listSchemas({ includeSystem }) {
      return meta(
        `SELECT s.SCHEMA_NAME AS name, s.DEFAULT_CHARACTER_SET_NAME AS charset,
           (SELECT COUNT(*) FROM information_schema.TABLES t WHERE t.TABLE_SCHEMA = s.SCHEMA_NAME) AS relations
         FROM information_schema.SCHEMATA s
         WHERE ? OR s.SCHEMA_NAME NOT IN (${SYSTEM_SCHEMAS.map(() => "?").join(", ")})
         ORDER BY s.SCHEMA_NAME`,
        [includeSystem, ...SYSTEM_SCHEMAS],
      );
    },

    async listTables({ schema, pattern, includeViews, limit }) {
      return meta(
        `SELECT t.TABLE_SCHEMA AS \`schema\`, t.TABLE_NAME AS name, ${KIND_SQL} AS kind,
           t.TABLE_ROWS AS estimated_rows, t.DATA_LENGTH + t.INDEX_LENGTH AS total_bytes,
           NULLIF(t.TABLE_COMMENT, '') AS comment
         FROM information_schema.TABLES t
         WHERE ${schema ? "t.TABLE_SCHEMA = ?" : `t.TABLE_SCHEMA NOT IN (${SYSTEM_SCHEMAS.map(() => "?").join(", ")})`}
           AND (? OR t.TABLE_TYPE = 'BASE TABLE')
           AND (? IS NULL OR LOWER(t.TABLE_NAME) LIKE LOWER(?))
         ORDER BY t.TABLE_SCHEMA, t.TABLE_NAME
         LIMIT ?`,
        [
          ...(schema ? [schema] : SYSTEM_SCHEMAS),
          includeViews,
          pattern ?? null,
          pattern ? likePattern(pattern) : null,
          limit,
        ],
      );
    },

    async describeTable(ref) {
      return inTransaction("read", 15_000, null, async (client) => {
        const t = await resolveTable(client, ref);
        const args = [t.schema, t.name];
        const cols = await metaQuery(
          client,
          `SELECT ORDINAL_POSITION AS position, COLUMN_NAME AS name, COLUMN_TYPE AS type,
             IS_NULLABLE = 'YES' AS nullable, COLUMN_DEFAULT AS \`default\`, NULLIF(EXTRA, '') AS extra,
             NULLIF(COLUMN_KEY, '') AS \`key\`, NULLIF(COLUMN_COMMENT, '') AS comment
           FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
          args,
        );
        const keyRows = await metaQuery<{
          name: string;
          column: string;
          ref_schema: string | null;
          ref_table: string | null;
          ref_column: string | null;
        }>(
          client,
          `SELECT CONSTRAINT_NAME AS name, COLUMN_NAME AS \`column\`, REFERENCED_TABLE_SCHEMA AS ref_schema,
             REFERENCED_TABLE_NAME AS ref_table, REFERENCED_COLUMN_NAME AS ref_column
           FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
           ORDER BY CONSTRAINT_NAME, ORDINAL_POSITION`,
          args,
        );
        const idxRows = await metaQuery<{
          name: string;
          non_unique: number;
          column: string | null;
          index_type: string;
        }>(
          client,
          `SELECT INDEX_NAME AS name, NON_UNIQUE AS non_unique, COLUMN_NAME AS \`column\`, INDEX_TYPE AS index_type
           FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
          args,
        );
        const referencedBy = await metaQuery(
          client,
          `SELECT CONCAT(TABLE_SCHEMA, '.', TABLE_NAME) AS \`table\`, CONSTRAINT_NAME AS name,
             GROUP_CONCAT(COLUMN_NAME ORDER BY ORDINAL_POSITION) AS columns
           FROM information_schema.KEY_COLUMN_USAGE
           WHERE REFERENCED_TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME = ?
           GROUP BY TABLE_SCHEMA, TABLE_NAME, CONSTRAINT_NAME ORDER BY 1, 2`,
          args,
        );
        const view =
          t.type === "VIEW"
            ? await metaQuery<{ definition: string }>(
                client,
                "SELECT VIEW_DEFINITION AS definition FROM information_schema.VIEWS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?",
                args,
              )
            : [];

        const constraints = new Map<
          string,
          { name: string; type: string; columns: string[]; references?: string }
        >();
        for (const k of keyRows) {
          const c = constraints.get(k.name) ?? {
            name: k.name,
            type: k.name === "PRIMARY" ? "primary_key" : k.ref_table ? "foreign_key" : "unique",
            columns: [],
            ...(k.ref_table ? { references: `${k.ref_schema}.${k.ref_table}` } : {}),
          };
          c.columns.push(k.ref_column ? `${k.column} → ${k.ref_column}` : k.column);
          constraints.set(k.name, c);
        }
        const indexes = new Map<string, { name: string; unique: boolean; type: string; columns: string[] }>();
        for (const i of idxRows) {
          const idx = indexes.get(i.name) ?? {
            name: i.name,
            unique: !Number(i.non_unique),
            type: i.index_type,
            columns: [],
          };
          if (i.column) idx.columns.push(i.column);
          indexes.set(i.name, idx);
        }
        const pk = constraints.get("PRIMARY");
        return {
          schema: t.schema,
          name: t.name,
          kind: t.type === "BASE TABLE" ? "table" : t.type.toLowerCase(),
          comment: t.comment || null,
          estimated_rows: t.rows,
          columns: cols,
          primary_key: pk ? `PRIMARY KEY (${pk.columns.join(", ")})` : null,
          constraints: [...constraints.values()],
          indexes: [...indexes.values()],
          referenced_by: referencedBy,
          ...(view[0] ? { view_definition: view[0].definition } : {}),
        };
      });
    },

    async sampleTable(ref, limit, timeoutMs) {
      const t = await inTransaction("read", 15_000, null, async (client) => {
        const r = await resolveTable(client, ref);
        return { ...r, columns: (await tableColumns(client, r.schema, r.name)).map((c) => c.name) };
      });
      if (!schemaAllowed(policy, t.schema)) {
        throw new Error(
          `"${t.schema}.${t.name}" is outside the schema allowlist of connection "${connection.name}"`,
        );
      }
      const visible = t.columns.filter(
        (column) => !columnHidden(policy, { schema: t.schema, table: t.name, column }),
      );
      if (visible.length === 0) throw new Error(`every column of ${t.schema}.${t.name} is hidden`);
      const select = visible.length === t.columns.length ? "*" : visible.map(quoteMySqlIdent).join(", ");
      return readQuery(
        `SELECT ${select} FROM ${quoteMySqlIdent(t.schema)}.${quoteMySqlIdent(t.name)} LIMIT ${Math.floor(limit)}`,
        undefined,
        limit,
        timeoutMs,
      );
    },

    async searchColumns({ pattern, schema, limit }) {
      return meta(
        `SELECT c.TABLE_SCHEMA AS \`schema\`, c.TABLE_NAME AS \`table\`, c.COLUMN_NAME AS \`column\`, c.COLUMN_TYPE AS type
         FROM information_schema.COLUMNS c
         WHERE LOWER(c.COLUMN_NAME) LIKE LOWER(?)
           AND ${schema ? "c.TABLE_SCHEMA = ?" : `c.TABLE_SCHEMA NOT IN (${SYSTEM_SCHEMAS.map(() => "?").join(", ")})`}
         ORDER BY c.TABLE_SCHEMA, c.TABLE_NAME, c.ORDINAL_POSITION
         LIMIT ?`,
        [likePattern(pattern), ...(schema ? [schema] : SYSTEM_SCHEMAS), limit],
      );
    },

    async run(input) {
      const values = asArrayParams(input.params);
      if (input.allow === "read") return readQuery(input.sql, values, input.maxRows, input.timeoutMs);
      if (!classAllowed(input.classified, input.allow))
        throw new Error(`statement needs ${input.classified} access`);
      const started = Date.now();
      if (input.classified !== "admin") {
        return runStatement(
          input.dryRun ? "dry_run" : "write",
          input.sql,
          values,
          input.maxRows,
          input.timeoutMs,
          input.classified,
          input.dryRun ? { rolled_back: true } : {},
        );
      }
      if (policy) throw new Error("admin statements are disabled on connections with a schema/column policy");
      if (input.dryRun) {
        throw new Error("MySQL DDL commits implicitly, so admin statements cannot be dry-run");
      }
      // admin DDL: autocommit, one statement.
      return withClient(async (client) => {
        await prepareSession(client, input.timeoutMs, null);
        const [raw, fields] = await q<unknown>(client, input.sql, values, input.timeoutMs + 5_000);
        return shape(raw, fields, input.maxRows, input.classified, { duration_ms: Date.now() - started });
      });
    },

    async explain({ sql, params, timeoutMs }) {
      const values = asArrayParams(params);
      return inTransaction("read", timeoutMs, null, async (client) => {
        await enforceSql(client, sql);
        const [rows] = await q<RowDataPacket[]>(
          client,
          `EXPLAIN FORMAT=JSON ${sql}`,
          values,
          timeoutMs + 5_000,
        );
        const text = rows[0] ? (Object.values(rows[0])[0] as string) : null;
        let plan: unknown = text;
        try {
          plan = text ? JSON.parse(text) : null;
        } catch {
          // keep raw text
        }
        return { plan };
      });
    },
  };
}
