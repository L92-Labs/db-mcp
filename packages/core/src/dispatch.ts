import { anyWritable, resolveConnection } from "./config.js";
import { limitRows, splitQualified } from "./format.js";
import {
  assertSqlPolicy,
  columnHidden,
  describePolicy,
  hasStarProjection,
  mentionsHidden,
  policyFor,
  positionalInsertTarget,
  positionalMergeTarget,
  schemaAllowed,
  type Policy,
} from "./policy.js";
import { accessToClass, assertSqlAllowed, classifySql, splitStatements } from "./sql/classify.js";
import { TOOL_NAMES, WRITE_TOOLS, toolSchemas, type ToolName } from "./tools.js";
import type { AdapterFactory, ConnectionConfig, DbAdapter, QueryResult, RuntimeConfig } from "./types.js";

export type DispatchContext = {
  config: RuntimeConfig;
  adapterFor: (connection: ConnectionConfig) => DbAdapter;
};

/** Memoize one adapter per connection for the lifetime of the context. */
export function createDispatchContext(config: RuntimeConfig, factory: AdapterFactory): DispatchContext {
  const cache = new Map<string, DbAdapter>();
  return {
    config,
    adapterFor(connection) {
      let adapter = cache.get(connection.name);
      if (!adapter) {
        adapter = factory(connection, config);
        cache.set(connection.name, adapter);
      }
      return adapter;
    },
  };
}

export function enabledTools(config: RuntimeConfig): ToolName[] {
  const writable = anyWritable(config);
  return TOOL_NAMES.filter((t) => writable || !WRITE_TOOLS.has(t));
}

function capRows(requested: number | undefined, config: RuntimeConfig): number {
  return Math.min(requested ?? config.maxRows, config.maxRows);
}

/** Apply the byte / cell budget to any row-returning result. */
function budget(result: QueryResult, config: RuntimeConfig): QueryResult {
  const { rows, stats } = limitRows(result.rows, config.maxResultBytes, config.maxCellChars);
  const out: QueryResult = { ...result, rows, row_count: rows.length };
  if (stats.rowsDropped > 0) {
    out.truncated = true;
    out.truncated_by = "bytes";
    out.max_result_bytes = config.maxResultBytes;
  } else if (result.truncated) {
    out.truncated_by = "rows";
  }
  if (stats.cellsTruncated > 0) out.cells_truncated = stats.cellsTruncated;
  return out;
}

function assertSchema(policy: Policy | null, schema: string | undefined | null, connection: string): void {
  if (!schemaAllowed(policy, schema)) {
    throw new Error(`schema "${schema}" is outside the allowlist of connection "${connection}"`);
  }
}

/**
 * Resolve the table a write will hit. Postgres pins search_path to the allowlist while
 * executing, so an unqualified name must be looked up in those schemas, in that order.
 */
async function describeWriteTarget(
  adapter: DbAdapter,
  policy: Policy,
  target: { schema?: string; table: string },
): Promise<Record<string, unknown>> {
  if (adapter.engine !== "postgres" || target.schema || !policy.schemas) return adapter.describeTable(target);
  for (const schema of policy.schemas) {
    try {
      return await adapter.describeTable({ schema, table: target.table });
    } catch (error) {
      if (!/not found/.test(error instanceof Error ? error.message : "")) throw error;
    }
  }
  throw new Error(`table or view not found in allowed schemas: ${target.table}`);
}

/** INSERT/REPLACE/MERGE without a column list writes every column, hidden ones included. */
async function assertPositionalWrite(sql: string, policy: Policy, adapter: DbAdapter, connection: string) {
  for (const tokens of splitStatements(sql, adapter.engine)) {
    const target = positionalInsertTarget(tokens) ?? positionalMergeTarget(tokens);
    if (!target) continue;
    const d = await describeWriteTarget(adapter, policy, target);
    const cols = (d.columns as Array<{ name: string }> | undefined) ?? [];
    const hit = cols.find((c) =>
      columnHidden(policy, {
        schema: d.schema as string,
        table: String(d.name ?? target.table),
        column: lastPart(c.name),
      }),
    );
    if (hit) {
      throw new Error(
        `${target.table} has hidden columns; list the columns you write (INSERT INTO ${target.table} (a, b) …) on connection "${connection}"`,
      );
    }
  }
}

/** Remove keys, indexes, references and view SQL that would reveal hidden columns or other schemas. */
async function redactDescription(
  policy: Policy,
  d: Record<string, unknown>,
  table: string,
  adapter: DbAdapter,
): Promise<Record<string, unknown>> {
  let known: string[] | null = null;
  const foreignSchema = async (text: string): Promise<boolean> => {
    if (!policy.schemas) return false;
    known ??= (await adapter.listSchemas({ includeSystem: true })).map((s) => String(s.name));
    const qualifiers = [...text.matchAll(/(?:"([^"]+)"|`([^`]+)`|([A-Za-z_][A-Za-z0-9_$]*))\s*\./g)].map(
      (m) => (m[1] ?? m[2] ?? m[3])!,
    );
    return qualifiers.some(
      (q) => known!.some((k) => k === q || k.toLowerCase() === q.toLowerCase()) && !schemaAllowed(policy, q),
    );
  };
  const out: Record<string, unknown> = { ...d };
  let removed = 0;
  const keep = async (item: unknown, ownerTable = table) => {
    const text = typeof item === "string" ? item : JSON.stringify(item);
    const drop = mentionsHidden(policy, text, ownerTable) || (await foreignSchema(text));
    if (drop) removed++;
    return !drop;
  };
  if (typeof out.primary_key === "string" && !(await keep(out.primary_key))) out.primary_key = "(hidden)";
  for (const key of ["constraints", "indexes"] as const) {
    if (!Array.isArray(out[key])) continue;
    const kept = [];
    for (const item of out[key] as unknown[]) if (await keep(item)) kept.push(item);
    out[key] = kept;
  }
  if (Array.isArray(out.referenced_by)) {
    const kept = [];
    for (const item of out.referenced_by as Array<{ table?: string }>) {
      const ref = String(item.table ?? "");
      const refSchema = ref.includes(".") ? ref.slice(0, ref.lastIndexOf(".")) : undefined;
      const refTable = ref.split(".").pop()!;
      if (schemaAllowed(policy, refSchema) && (await keep(item, refTable))) kept.push(item);
      else if (!schemaAllowed(policy, refSchema)) removed++;
    }
    out.referenced_by = kept;
  }
  if (typeof out.view_definition === "string" && !(await keep(out.view_definition)))
    delete out.view_definition;
  if (Array.isArray(out.clustering)) {
    out.clustering = (out.clustering as string[]).filter((c) => !columnHidden(policy, { table, column: c }));
  }
  const part = out.partitioning as { field?: string } | null | undefined;
  if (part?.field && columnHidden(policy, { table, column: part.field })) out.partitioning = { hidden: true };
  if (removed > 0) out.redacted_items = removed;
  return out;
}

function lastPart(name: string): string {
  return name.split(".").pop()!;
}

export async function dispatchTool(name: string, args: unknown, ctx: DispatchContext): Promise<unknown> {
  if (!enabledTools(ctx.config).includes(name as ToolName)) {
    throw new Error(`unknown or disabled tool: ${name}`);
  }
  const { config } = ctx;
  const timeoutMs = config.statementTimeoutMs;

  switch (name as ToolName) {
    case "connections_list": {
      toolSchemas.connections_list.parse(args ?? {});
      return {
        default_connection: config.defaultConnection,
        max_rows: config.maxRows,
        max_result_bytes: config.maxResultBytes,
        statement_timeout_ms: timeoutMs,
        connections: Object.values(config.connections).map((c) => ({
          name: c.name,
          engine: c.engine,
          access: c.access,
          description: c.description ?? null,
          policy: describePolicy(policyFor(c)),
          ...(c.engine === "bigquery"
            ? {
                project_id: c.projectId,
                location: c.location ?? null,
                default_dataset: c.defaultDataset ?? null,
              }
            : { via: c.hyperdrive ? `hyperdrive:${c.hyperdrive}` : "url" }),
        })),
      };
    }
    case "connection_info": {
      const a = toolSchemas.connection_info.parse(args ?? {});
      const connection = resolveConnection(config, a.connection);
      const info = await ctx.adapterFor(connection).info();
      return {
        connection: connection.name,
        engine: connection.engine,
        access: connection.access,
        policy: describePolicy(policyFor(connection)),
        ...info,
      };
    }
    case "schemas_list": {
      const a = toolSchemas.schemas_list.parse(args ?? {});
      const connection = resolveConnection(config, a.connection);
      const policy = policyFor(connection);
      const schemas = (
        await ctx.adapterFor(connection).listSchemas({ includeSystem: a.include_system ?? false })
      ).filter((s) => schemaAllowed(policy, String(s.name)));
      return { connection: connection.name, count: schemas.length, schemas };
    }
    case "tables_list": {
      const a = toolSchemas.tables_list.parse(args ?? {});
      const connection = resolveConnection(config, a.connection);
      const policy = policyFor(connection);
      const schema = a.schema?.trim() || undefined;
      const limit = a.limit ?? 500;
      const input = { pattern: a.pattern?.trim() || undefined, includeViews: a.include_views ?? true, limit };
      const adapter = ctx.adapterFor(connection);
      let tables: Record<string, unknown>[];
      if (schema) {
        assertSchema(policy, schema, connection.name);
        tables = await adapter.listTables({ ...input, schema });
      } else if (policy?.schemas) {
        tables = [];
        for (const s of policy.schemas) {
          if (tables.length >= limit) break;
          tables.push(...(await adapter.listTables({ ...input, schema: s, limit: limit - tables.length })));
        }
      } else {
        tables = await adapter.listTables(input);
      }
      return { connection: connection.name, count: tables.length, tables };
    }
    case "table_describe": {
      const a = toolSchemas.table_describe.parse(args ?? {});
      const connection = resolveConnection(config, a.connection);
      const policy = policyFor(connection);
      const ref = splitQualified(a.schema, a.table);
      assertSchema(policy, ref.schema, connection.name);
      const d = await ctx.adapterFor(connection).describeTable(ref);
      const schema = d.schema as string | undefined;
      assertSchema(policy, schema, connection.name);
      if (policy && Array.isArray(d.columns)) {
        const table = String(d.name ?? ref.table);
        const visible = (d.columns as Array<{ name: string }>).filter(
          (c) =>
            !columnHidden(policy, { schema, table, column: lastPart(c.name) }) &&
            !columnHidden(policy, { schema, table, column: c.name.split(".")[0]! }),
        );
        const hidden = d.columns.length - visible.length;
        const redacted = await redactDescription(policy, d, table, ctx.adapterFor(connection));
        return {
          connection: connection.name,
          ...redacted,
          columns: visible,
          ...(hidden ? { hidden_columns: hidden } : {}),
        };
      }
      return { connection: connection.name, ...d };
    }
    case "table_sample": {
      const a = toolSchemas.table_sample.parse(args ?? {});
      const connection = resolveConnection(config, a.connection);
      const ref = splitQualified(a.schema, a.table);
      assertSchema(policyFor(connection), ref.schema, connection.name);
      const limit = Math.min(a.limit ?? 10, config.maxRows);
      const result = await ctx.adapterFor(connection).sampleTable(ref, limit, timeoutMs);
      return { connection: connection.name, ...budget(result, config) };
    }
    case "columns_search": {
      const a = toolSchemas.columns_search.parse(args ?? {});
      const connection = resolveConnection(config, a.connection);
      const policy = policyFor(connection);
      const schema = a.schema?.trim() || undefined;
      assertSchema(policy, schema, connection.name);
      const limit = a.limit ?? 200;
      const adapter = ctx.adapterFor(connection);
      let found: Record<string, unknown>[];
      if (!schema && policy?.schemas) {
        // Search each allowed schema so forbidden ones cannot use up the limit.
        found = [];
        for (const s of policy.schemas) {
          if (found.length >= limit) break;
          found.push(
            ...(await adapter.searchColumns({ pattern: a.pattern, schema: s, limit: limit - found.length })),
          );
        }
      } else {
        found = await adapter.searchColumns({ pattern: a.pattern, schema, limit });
      }
      const columns = found.filter(
        (c) =>
          schemaAllowed(policy, c.schema as string) &&
          !columnHidden(policy, {
            schema: c.schema as string,
            table: c.table as string,
            column: String(c.column),
          }),
      );
      return { connection: connection.name, count: columns.length, columns };
    }
    case "sql_query":
    case "sql_execute": {
      const tool = name as "sql_query" | "sql_execute";
      const a = toolSchemas.sql_execute.parse(args ?? {});
      if (tool === "sql_query" && "dry_run" in (args as object))
        throw new Error("dry_run is a sql_execute option");
      const connection = resolveConnection(config, a.connection);
      const allow = tool === "sql_query" ? "read" : accessToClass(connection.access);
      const classified = assertSqlAllowed(a.sql, connection.engine, allow, {
        connection: connection.name,
        tool,
      });
      const policy = policyFor(connection);
      assertSqlPolicy(a.sql, connection.engine, policy, classified.statements, connection.name);
      if (policy?.rules.length && classified.class === "write") {
        await assertPositionalWrite(a.sql, policy, ctx.adapterFor(connection), connection.name);
      }
      const dryRun = tool === "sql_execute" && a.dry_run === true;
      const result = await ctx.adapterFor(connection).run({
        sql: a.sql,
        params: a.params,
        maxRows: capRows(a.max_rows, config),
        timeoutMs,
        allow,
        classified: classified.class,
        dryRun,
      });
      return { connection: connection.name, ...(dryRun ? { dry_run: true } : {}), ...budget(result, config) };
    }
    case "sql_explain": {
      const a = toolSchemas.sql_explain.parse(args ?? {});
      const connection = resolveConnection(config, a.connection);
      // EXPLAIN without ANALYZE and BigQuery dry runs never execute, so any single statement is fine.
      const classified = classifySql(a.sql, connection.engine);
      if (classified.statements.length > 1) throw new Error("sql_explain takes one statement");
      if (classified.statements[0]!.keyword === "EXPLAIN") {
        throw new Error("pass the statement itself; sql_explain adds EXPLAIN");
      }
      const policy = policyFor(connection);
      assertSqlPolicy(a.sql, connection.engine, policy, classified.statements, connection.name);
      if (
        policy?.rules.length &&
        connection.engine !== "postgres" &&
        splitStatements(a.sql, connection.engine).some(hasStarProjection)
      ) {
        // Plans list the columns a * expands to; Postgres checks its plan instead.
        throw new Error(
          `list columns explicitly: SELECT * is refused by sql_explain on connection "${connection.name}" (hidden columns)`,
        );
      }
      const plan = await ctx.adapterFor(connection).explain({ sql: a.sql, params: a.params, timeoutMs });
      return { connection: connection.name, statement_class: classified.class, ...plan };
    }
    default:
      throw new Error(`unhandled tool: ${name}`);
  }
}
