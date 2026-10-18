import pg from "pg";
import Cursor from "pg-cursor";
import { likePattern, toJsonValue } from "../format.js";
import { columnHidden, policyFor, schemaAllowed } from "../policy.js";
import { classAllowed, classifySql } from "../sql/classify.js";
import type {
  ColumnMeta,
  DbAdapter,
  PostgresConnection,
  QueryResult,
  RunInput,
  SqlParams,
  StatementClass,
  TableRef,
} from "../types.js";

export type PgLease = {
  client: pg.ClientBase;
  /** Pass the error when the connection may be broken so pools can discard it. */
  release: (error?: Error) => Promise<void> | void;
};

export type PgConnector = () => Promise<PgLease>;

// date, time, timestamp, timestamptz, timetz, interval → keep server text (no local-TZ shifting).
const RAW_TEXT_OIDS = new Set([1082, 1083, 1114, 1184, 1266, 1186]);

export const pgTypes: pg.CustomTypesConfig = {
  getTypeParser: ((oid: number, format?: string) =>
    RAW_TEXT_OIDS.has(oid)
      ? (v: string) => v
      : pg.types.getTypeParser(oid, format as "text")) as pg.CustomTypesConfig["getTypeParser"],
};

/** Client config shared by Node pools and per-request Worker clients. */
export function pgClientConfig(
  connection: PostgresConnection,
  connectionString: string,
  opts: { statementTimeoutMs?: number; queryTimeoutMs?: number } = {},
): pg.ClientConfig {
  const ssl =
    connection.ssl === undefined
      ? undefined
      : connection.ssl === false
        ? false
        : connection.ssl === "no-verify"
          ? { rejectUnauthorized: false }
          : true;
  return {
    connectionString,
    ssl,
    types: pgTypes,
    application_name: "db-mcp",
    statement_timeout: opts.statementTimeoutMs,
    query_timeout: opts.queryTimeoutMs,
  };
}

const META_TIMEOUT_MS = 15_000;

const SYSTEM_SCHEMA_SQL =
  "n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast') AND n.nspname NOT LIKE 'pg_temp_%' AND n.nspname NOT LIKE 'pg_toast_temp_%'";

const KIND_SQL = `CASE c.relkind WHEN 'r' THEN 'table' WHEN 'p' THEN 'partitioned_table' WHEN 'v' THEN 'view'
  WHEN 'm' THEN 'materialized_view' WHEN 'f' THEN 'foreign_table' ELSE c.relkind::text END`;

const TX_CONTROL = new Set([
  "BEGIN",
  "START",
  "COMMIT",
  "END",
  "ROLLBACK",
  "ABORT",
  "SAVEPOINT",
  "RELEASE",
  "PREPARE",
]);

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function asArrayParams(params: SqlParams | undefined): unknown[] {
  if (params === undefined) return [];
  if (!Array.isArray(params)) {
    throw new Error("postgres params must be an array bound to $1, $2…");
  }
  return params;
}

type CursorRead = {
  rows: Record<string, unknown>[];
  fields: pg.FieldDef[];
  rowCount: number | null;
  command?: string;
};

function readCursor(
  client: pg.ClientBase,
  text: string,
  values: unknown[],
  limit: number,
): Promise<CursorRead> {
  const cursor = client.query(new Cursor(text, values, { types: pgTypes }));
  return new Promise((resolve, reject) => {
    cursor.read(limit, (err, rows, result) => {
      if (err) {
        reject(err);
        return;
      }
      cursor.close((closeErr) => {
        if (closeErr) {
          reject(closeErr);
          return;
        }
        resolve({
          rows: rows as Record<string, unknown>[],
          fields: result?.fields ?? [],
          rowCount: result?.rowCount ?? null,
          command: result?.command || undefined,
        });
      });
    });
  });
}

export function createPostgresAdapter(
  connection: PostgresConnection,
  opts: { connect: PgConnector },
): DbAdapter {
  const typeNames = new Map<number, string>();
  const policy = policyFor(connection);

  async function withClient<T>(fn: (client: pg.ClientBase) => Promise<T>): Promise<T> {
    const lease = await opts.connect();
    let broken: Error | undefined;
    try {
      return await fn(lease.client);
    } catch (error) {
      broken = error instanceof Error ? error : new Error(String(error));
      throw error;
    } finally {
      await lease.release(broken);
    }
  }

  /** BEGIN READ ONLY (+ local timeout) … ROLLBACK. Server-enforced: writes fail even if the classifier missed them. */
  async function inTransaction<T>(
    mode: "read" | "write" | "dry_run",
    timeoutMs: number,
    fn: (client: pg.ClientBase) => Promise<T>,
  ): Promise<T> {
    return withClient(async (client) => {
      await client.query(mode === "read" ? "BEGIN TRANSACTION READ ONLY" : "BEGIN");
      try {
        await client.query(`SET LOCAL statement_timeout = ${Math.max(1, Math.floor(timeoutMs))}`);
        const out = await fn(client);
        await client.query(mode === "write" ? "COMMIT" : "ROLLBACK");
        return out;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
    });
  }

  async function columnMeta(client: pg.ClientBase, fields: pg.FieldDef[]): Promise<ColumnMeta[]> {
    const missing = [...new Set(fields.map((f) => f.dataTypeID))].filter((oid) => !typeNames.has(oid));
    if (missing.length > 0) {
      const res = await client.query<{ oid: number; name: string }>(
        "SELECT oid::int AS oid, format_type(oid, NULL) AS name FROM pg_type WHERE oid = ANY($1::oid[])",
        [missing],
      );
      for (const r of res.rows) typeNames.set(r.oid, r.name);
    }
    return fields.map((f) => ({ name: f.name, type: typeNames.get(f.dataTypeID) ?? `oid:${f.dataTypeID}` }));
  }

  function shape(
    rows: Record<string, unknown>[],
    columns: ColumnMeta[],
    maxRows: number,
    cls: StatementClass,
    extra: Partial<QueryResult>,
  ): QueryResult {
    const truncated = rows.length > maxRows;
    const kept = truncated ? rows.slice(0, maxRows) : rows;
    return {
      columns,
      rows: kept.map((r) => toJsonValue(r) as Record<string, unknown>),
      row_count: kept.length,
      truncated,
      statement_class: cls,
      ...extra,
    };
  }

  /**
   * Schema/column policy, checked on the real plan: restrict search_path, then
   * EXPLAIN (VERBOSE) and inspect every scanned relation and the columns read from it.
   */
  async function enforcePolicy(client: pg.ClientBase, sql: string, values: unknown[]): Promise<void> {
    if (!policy) return;
    if (policy.schemas) {
      await client.query(`SET LOCAL search_path = ${policy.schemas.map(quoteIdent).join(", ")}`);
    }
    const keyword = classifySql(sql, "postgres").statements[0]?.keyword;
    if (keyword === "SHOW") return;
    const res = await readCursor(client, `EXPLAIN (VERBOSE, FORMAT JSON) ${sql}`, values, 10);
    const raw = res.rows[0]?.["QUERY PLAN"];
    const root = (Array.isArray(raw) ? raw[0] : raw) as Record<string, unknown> | undefined;
    const nodes: Record<string, unknown>[] = [];
    const walk = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") {
        const node = v as Record<string, unknown>;
        if ("Node Type" in node) nodes.push(node);
        Object.values(node).forEach(walk);
      }
    };
    walk(root);
    const columnCache = new Map<string, string[]>(); // per statement: never stale

    for (const node of nodes) {
      const schema = node.Schema as string | undefined;
      const table = node["Relation Name"] as string | undefined;
      if (!table) {
        if (schema && schema !== "pg_catalog" && !schemaAllowed(policy, schema)) {
          throw new Error(
            `function in schema "${schema}" is outside the allowlist of connection "${connection.name}"`,
          );
        }
        continue;
      }
      if (!schemaAllowed(policy, schema)) {
        throw new Error(
          `"${schema}.${table}" is outside the schema allowlist of connection "${connection.name}"`,
        );
      }
      if (policy.rules.length === 0) continue;
      const hidden = (await relationColumns(client, schema!, table, columnCache)).filter((column) =>
        columnHidden(policy, { schema, table, column }),
      );
      if (hidden.length === 0) continue;
      // Columns this scan reads (Output, Filter, Index Cond…), qualified or not, plus whole-row refs.
      const text = Object.entries(node)
        .filter(([k]) => k !== "Plans")
        .flatMap(([, v]) =>
          typeof v === "string" ? [v] : Array.isArray(v) ? v.filter((x) => typeof x === "string") : [],
        )
        .join("\n")
        // String constants ('api_token'::text) are not column references.
        .replace(/'(?:[^']|'')*'/g, "''");
      const alias = String(node.Alias ?? table);
      const wholeRow = new RegExp(
        `(?:^|[^A-Za-z0-9_$"])(?:"${escapeRe(alias.replace(/"/g, '""'))}"|${escapeRe(alias)})\\.\\*`,
      );
      const hit = wholeRow.test(text)
        ? hidden[0]
        : hidden.find((column) =>
            new RegExp(
              `(?:^|[^A-Za-z0-9_$])(?:"${escapeRe(column.replace(/"/g, '""'))}"|${escapeRe(column)})(?:$|[^A-Za-z0-9_$])`,
            ).test(text),
          );
      if (hit) throw new Error(`column ${table}.${hit} is hidden on connection "${connection.name}"`);
    }
  }

  async function relationColumns(
    client: pg.ClientBase,
    schema: string,
    table: string,
    cache = new Map<string, string[]>(),
  ): Promise<string[]> {
    const key = `${schema}.${table}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const res = await client.query<{ name: string }>(
      "SELECT attname AS name FROM pg_attribute WHERE attrelid = $1::regclass AND attnum > 0 AND NOT attisdropped ORDER BY attnum",
      [`${quoteIdent(schema)}.${quoteIdent(table)}`],
    );
    const names = res.rows.map((r) => r.name);
    cache.set(key, names);
    return names;
  }

  async function readQuery(
    sql: string,
    values: unknown[],
    maxRows: number,
    timeoutMs: number,
  ): Promise<QueryResult> {
    const started = Date.now();
    return inTransaction("read", timeoutMs, async (client) => {
      await enforcePolicy(client, sql, values);
      const res = await readCursor(client, sql, values, maxRows + 1);
      const columns = await columnMeta(client, res.fields);
      return shape(res.rows, columns, maxRows, "read", {
        command: res.command,
        duration_ms: Date.now() - started,
      });
    });
  }

  async function metaQuery<R extends Record<string, unknown>>(
    client: pg.ClientBase,
    sql: string,
    values: unknown[] = [],
  ): Promise<R[]> {
    const res = await client.query<R>(sql, values);
    return res.rows.map((r) => toJsonValue(r) as R);
  }

  function meta<R extends Record<string, unknown>>(sql: string, values: unknown[] = []): Promise<R[]> {
    return inTransaction("read", META_TIMEOUT_MS, (client) => metaQuery<R>(client, sql, values));
  }

  async function resolveRelation(
    client: pg.ClientBase,
    ref: TableRef,
  ): Promise<{
    oid: number;
    schema: string;
    name: string;
    relkind: string;
    comment: string | null;
    estimated_rows: number | null;
  }> {
    const rows = await metaQuery<{
      oid: number;
      schema: string;
      name: string;
      relkind: string;
      comment: string | null;
      estimated_rows: string | null;
      visible: boolean;
      exact: boolean;
    }>(
      client,
      `SELECT c.oid::int AS oid, n.nspname AS schema, c.relname AS name, c.relkind::text AS relkind,
        obj_description(c.oid, 'pg_class') AS comment,
        CASE WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples::bigint END AS estimated_rows,
        pg_table_is_visible(c.oid) AS visible, c.relname = $1 AS exact
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE (c.relname = $1 OR lower(c.relname) = lower($1))
        AND ($2::text IS NULL OR n.nspname = $2 OR lower(n.nspname) = lower($2))
        AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
      ORDER BY exact DESC, visible DESC, n.nspname`,
      [ref.table, ref.schema ?? null],
    );
    const label = ref.schema ? `${ref.schema}.${ref.table}` : ref.table;
    if (rows.length === 0) throw new Error(`table or view not found: ${label}`);
    const best = rows[0]!;
    if (!ref.schema && rows.length > 1 && !best.visible) {
      const options = rows.map((r) => `${r.schema}.${r.name}`).join(", ");
      throw new Error(`"${ref.table}" is ambiguous; pass schema. Candidates: ${options}`);
    }
    return {
      oid: best.oid,
      schema: best.schema,
      name: best.name,
      relkind: best.relkind,
      comment: best.comment,
      estimated_rows: best.estimated_rows === null ? null : Number(best.estimated_rows),
    };
  }

  return {
    engine: "postgres",

    async info() {
      const [row] = await meta(
        `SELECT current_setting('server_version') AS server_version, version() AS version,
          current_database() AS database, current_user AS user, current_schema() AS current_schema,
          (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS superuser,
          pg_database_size(current_database())::bigint AS database_bytes,
          current_setting('default_transaction_read_only') = 'on' AS role_default_read_only,
          pg_is_in_recovery() AS replica`,
      );
      return {
        via: connection.hyperdrive ? `hyperdrive:${connection.hyperdrive}` : "url",
        ...row,
        enforcement:
          "sql_query runs in BEGIN TRANSACTION READ ONLY; use a read-only database role for defense in depth",
      };
    },

    async listSchemas({ includeSystem }) {
      return meta(
        `SELECT n.nspname AS name, pg_get_userbyid(n.nspowner) AS owner,
          (SELECT count(*)::int FROM pg_class c WHERE c.relnamespace = n.oid AND c.relkind IN ('r','p','v','m','f')) AS relations,
          obj_description(n.oid, 'pg_namespace') AS comment
        FROM pg_namespace n
        WHERE $1::boolean OR (${SYSTEM_SCHEMA_SQL})
        ORDER BY n.nspname`,
        [includeSystem],
      );
    },

    async listTables({ schema, pattern, includeViews, limit }) {
      const kinds = includeViews ? ["r", "p", "v", "m", "f"] : ["r", "p", "f"];
      return meta(
        `SELECT n.nspname AS schema, c.relname AS name, ${KIND_SQL} AS kind,
          CASE WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples::bigint END AS estimated_rows,
          CASE WHEN c.relkind IN ('r','p','m') THEN pg_total_relation_size(c.oid) END AS total_bytes,
          obj_description(c.oid, 'pg_class') AS comment
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind::text = ANY($1::text[]) AND NOT c.relispartition
          AND (${schema ? "n.nspname = $2" : SYSTEM_SCHEMA_SQL + " AND $2::text IS NULL"})
          AND ($3::text IS NULL OR c.relname ILIKE $3)
        ORDER BY n.nspname, c.relname
        LIMIT $4`,
        [kinds, schema ?? null, pattern ? likePattern(pattern) : null, limit],
      );
    },

    async describeTable(ref) {
      return inTransaction("read", META_TIMEOUT_MS, async (client) => {
        const rel = await resolveRelation(client, ref);
        const columns = await metaQuery(
          client,
          `SELECT a.attnum AS position, a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
            NOT a.attnotnull AS nullable, pg_get_expr(d.adbin, d.adrelid) AS default,
            NULLIF(a.attidentity, '') IS NOT NULL AS identity, NULLIF(a.attgenerated, '') IS NOT NULL AS generated,
            col_description(a.attrelid, a.attnum) AS comment
          FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
          WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped
          ORDER BY a.attnum`,
          [rel.oid],
        );
        const constraints = await metaQuery(
          client,
          `SELECT conname AS name,
            CASE contype WHEN 'p' THEN 'primary_key' WHEN 'f' THEN 'foreign_key' WHEN 'u' THEN 'unique'
              WHEN 'c' THEN 'check' WHEN 'x' THEN 'exclusion' ELSE contype::text END AS type,
            pg_get_constraintdef(oid, true) AS definition
          FROM pg_constraint WHERE conrelid = $1 ORDER BY contype, conname`,
          [rel.oid],
        );
        const indexes = await metaQuery(
          client,
          `SELECT i.relname AS name, ix.indisprimary AS primary, ix.indisunique AS unique,
            pg_get_indexdef(ix.indexrelid) AS definition
          FROM pg_index ix JOIN pg_class i ON i.oid = ix.indexrelid
          WHERE ix.indrelid = $1 ORDER BY i.relname`,
          [rel.oid],
        );
        const referencedBy = await metaQuery(
          client,
          `SELECT n.nspname || '.' || c.relname AS table, k.conname AS name, pg_get_constraintdef(k.oid, true) AS definition
          FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE k.confrelid = $1 AND k.contype = 'f' ORDER BY 1, 2`,
          [rel.oid],
        );
        const view =
          rel.relkind === "v" || rel.relkind === "m"
            ? await metaQuery<{ definition: string }>(
                client,
                "SELECT pg_get_viewdef($1::oid, true) AS definition",
                [rel.oid],
              )
            : [];
        const kinds: Record<string, string> = {
          r: "table",
          p: "partitioned_table",
          v: "view",
          m: "materialized_view",
          f: "foreign_table",
        };
        const pk = constraints.find((c) => c.type === "primary_key");
        return {
          schema: rel.schema,
          name: rel.name,
          kind: kinds[rel.relkind] ?? rel.relkind,
          comment: rel.comment,
          estimated_rows: rel.estimated_rows,
          columns,
          primary_key: pk ? pk.definition : null,
          constraints,
          indexes,
          referenced_by: referencedBy,
          ...(view[0] ? { view_definition: view[0].definition } : {}),
        };
      });
    },

    async sampleTable(ref, limit, timeoutMs) {
      let name = ref.schema ? `${quoteIdent(ref.schema)}.${quoteIdent(ref.table)}` : quoteIdent(ref.table);
      let select = "*";
      if (policy) {
        const rel = await inTransaction("read", META_TIMEOUT_MS, async (client) => {
          const r = await resolveRelation(client, ref);
          return { ...r, columns: await relationColumns(client, r.schema, r.name) };
        });
        if (!schemaAllowed(policy, rel.schema)) {
          throw new Error(
            `"${rel.schema}.${rel.name}" is outside the schema allowlist of connection "${connection.name}"`,
          );
        }
        name = `${quoteIdent(rel.schema)}.${quoteIdent(rel.name)}`;
        const visible = rel.columns.filter(
          (column) => !columnHidden(policy, { schema: rel.schema, table: rel.name, column }),
        );
        if (visible.length === 0) throw new Error(`every column of ${rel.schema}.${rel.name} is hidden`);
        select = visible.map(quoteIdent).join(", ");
      }
      return readQuery(`SELECT ${select} FROM ${name} LIMIT ${Math.floor(limit)}`, [], limit, timeoutMs);
    },

    async searchColumns({ pattern, schema, limit }) {
      return meta(
        `SELECT n.nspname AS schema, c.relname AS table, ${KIND_SQL} AS kind, a.attname AS column,
          format_type(a.atttypid, a.atttypmod) AS type
        FROM pg_attribute a
          JOIN pg_class c ON c.oid = a.attrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE a.attnum > 0 AND NOT a.attisdropped AND c.relkind IN ('r','p','v','m','f') AND NOT c.relispartition
          AND a.attname ILIKE $1
          AND (${schema ? "n.nspname = $2" : SYSTEM_SCHEMA_SQL + " AND $2::text IS NULL"})
        ORDER BY n.nspname, c.relname, a.attnum
        LIMIT $3`,
        [likePattern(pattern), schema ?? null, limit],
      );
    },

    async run(input: RunInput) {
      const values = asArrayParams(input.params);
      if (input.allow === "read") {
        // sql_query / read_only: always inside BEGIN TRANSACTION READ ONLY.
        return readQuery(input.sql, values, input.maxRows, input.timeoutMs);
      }
      if (!classAllowed(input.classified, input.allow)) {
        throw new Error(`statement needs ${input.classified} access`);
      }
      const started = Date.now();
      if (input.classified !== "admin") {
        // One statement (extended protocol), committed atomically (or rolled back for dry runs).
        return inTransaction(input.dryRun ? "dry_run" : "write", input.timeoutMs, async (client) => {
          await enforcePolicy(client, input.sql, values);
          const res = await readCursor(client, input.sql, values, input.maxRows + 1);
          const columns = await columnMeta(client, res.fields);
          return shape(res.rows, columns, input.maxRows, input.classified, {
            command: res.command,
            affected_rows: res.rowCount,
            ...(input.dryRun ? { rolled_back: true } : {}),
            duration_ms: Date.now() - started,
          });
        });
      }
      if (policy) throw new Error("admin statements are disabled on connections with a schema/column policy");
      if (input.dryRun) {
        const control = classifySql(input.sql, "postgres").statements.find((st) =>
          TX_CONTROL.has(st.keyword),
        );
        if (control)
          throw new Error(`dry_run cannot contain ${control.keyword}; it runs inside one transaction`);
      }
      // admin DDL / scripts: autocommit (VACUUM, CREATE INDEX CONCURRENTLY…), simple protocol when no params.
      // dry_run wraps the script in BEGIN … ROLLBACK (non-transactional commands then fail, as they should).
      return withClient(async (client) => {
        if (input.dryRun) await client.query("BEGIN");
        let raw: pg.QueryResult | pg.QueryResult[];
        try {
          raw = (await client.query(input.sql, values.length ? values : undefined)) as
            pg.QueryResult | pg.QueryResult[];
        } finally {
          if (input.dryRun) await client.query("ROLLBACK").catch(() => undefined);
        }
        const results = Array.isArray(raw) ? raw : [raw];
        const last = results[results.length - 1]!;
        const columns = await columnMeta(client, last.fields ?? []);
        return shape(last.rows ?? [], columns, input.maxRows, input.classified, {
          command: last.command,
          affected_rows: last.rowCount,
          statements: results.length,
          ...(input.dryRun ? { rolled_back: true } : {}),
          duration_ms: Date.now() - started,
        });
      });
    },

    async explain({ sql, params, timeoutMs }) {
      const values = asArrayParams(params);
      return inTransaction("read", timeoutMs, async (client) => {
        await enforcePolicy(client, sql, values);
        const res = await readCursor(client, `EXPLAIN (FORMAT JSON) ${sql}`, values, 10);
        const plan = res.rows[0]?.["QUERY PLAN"];
        return { plan: Array.isArray(plan) ? plan[0] : plan };
      });
    },
  };
}
