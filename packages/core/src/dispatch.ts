import { anyWritable, resolveConnection } from "./config.js";
import { splitQualified } from "./format.js";
import { accessToClass, assertSqlAllowed, classifySql } from "./sql/classify.js";
import { TOOL_NAMES, WRITE_TOOLS, toolSchemas, type ToolName } from "./tools.js";
import type { AdapterFactory, ConnectionConfig, DbAdapter, RuntimeConfig } from "./types.js";

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
        statement_timeout_ms: timeoutMs,
        connections: Object.values(config.connections).map((c) => ({
          name: c.name,
          engine: c.engine,
          access: c.access,
          description: c.description ?? null,
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
      return { connection: connection.name, engine: connection.engine, access: connection.access, ...info };
    }
    case "schemas_list": {
      const a = toolSchemas.schemas_list.parse(args ?? {});
      const connection = resolveConnection(config, a.connection);
      const schemas = await ctx
        .adapterFor(connection)
        .listSchemas({ includeSystem: a.include_system ?? false });
      return { connection: connection.name, count: schemas.length, schemas };
    }
    case "tables_list": {
      const a = toolSchemas.tables_list.parse(args ?? {});
      const connection = resolveConnection(config, a.connection);
      const tables = await ctx.adapterFor(connection).listTables({
        schema: a.schema?.trim() || undefined,
        pattern: a.pattern?.trim() || undefined,
        includeViews: a.include_views ?? true,
        limit: a.limit ?? 500,
      });
      return { connection: connection.name, count: tables.length, tables };
    }
    case "table_describe": {
      const a = toolSchemas.table_describe.parse(args ?? {});
      const connection = resolveConnection(config, a.connection);
      const ref = splitQualified(a.schema, a.table);
      return { connection: connection.name, ...(await ctx.adapterFor(connection).describeTable(ref)) };
    }
    case "table_sample": {
      const a = toolSchemas.table_sample.parse(args ?? {});
      const connection = resolveConnection(config, a.connection);
      const ref = splitQualified(a.schema, a.table);
      const limit = Math.min(a.limit ?? 10, config.maxRows);
      return {
        connection: connection.name,
        ...(await ctx.adapterFor(connection).sampleTable(ref, limit, timeoutMs)),
      };
    }
    case "columns_search": {
      const a = toolSchemas.columns_search.parse(args ?? {});
      const connection = resolveConnection(config, a.connection);
      const columns = await ctx.adapterFor(connection).searchColumns({
        pattern: a.pattern,
        schema: a.schema?.trim() || undefined,
        limit: a.limit ?? 200,
      });
      return { connection: connection.name, count: columns.length, columns };
    }
    case "sql_query": {
      const a = toolSchemas.sql_query.parse(args ?? {});
      const connection = resolveConnection(config, a.connection);
      const classified = assertSqlAllowed(a.sql, connection.engine, "read", {
        connection: connection.name,
        tool: "sql_query",
      });
      const result = await ctx.adapterFor(connection).run({
        sql: a.sql,
        params: a.params,
        maxRows: capRows(a.max_rows, config),
        timeoutMs,
        allow: "read",
        classified: classified.class,
      });
      return { connection: connection.name, ...result };
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
      const plan = await ctx.adapterFor(connection).explain({ sql: a.sql, params: a.params, timeoutMs });
      return { connection: connection.name, statement_class: classified.class, ...plan };
    }
    case "sql_execute": {
      const a = toolSchemas.sql_execute.parse(args ?? {});
      const connection = resolveConnection(config, a.connection);
      const allow = accessToClass(connection.access);
      const classified = assertSqlAllowed(a.sql, connection.engine, allow, {
        connection: connection.name,
        tool: "sql_execute",
      });
      const result = await ctx.adapterFor(connection).run({
        sql: a.sql,
        params: a.params,
        maxRows: capRows(a.max_rows, config),
        timeoutMs,
        allow,
        classified: classified.class,
      });
      return { connection: connection.name, ...result };
    }
    default:
      throw new Error(`unhandled tool: ${name}`);
  }
}
