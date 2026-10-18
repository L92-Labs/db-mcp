import { z } from "zod";

const connection = z
  .string()
  .optional()
  .describe("Connection name from connections_list (defaults to the default connection)");
const schema = z
  .string()
  .optional()
  .describe("Postgres schema or BigQuery dataset (BigQuery: optionally project.dataset)");
const table = z
  .string()
  .min(1)
  .describe("Table or view name; schema.table (or project.dataset.table) also accepted");
const sql = z.string().min(1).describe("One SQL statement");
const params = z
  .union([z.array(z.unknown()), z.record(z.string(), z.unknown())])
  .optional()
  .describe(
    "Bind parameters. Postgres: array for $1, $2… BigQuery: array for ? or object for @name; a value may be {type, value} to force a BigQuery type",
  );
const maxRows = z
  .number()
  .int()
  .min(1)
  .max(10_000)
  .optional()
  .describe("Max rows to return (capped by DB_MAX_ROWS)");

export const TOOL_SHAPES = {
  connections_list: {},
  connection_info: { connection },
  schemas_list: {
    connection,
    include_system: z.boolean().optional().describe("Include pg_catalog / information_schema"),
  },
  tables_list: {
    connection,
    schema,
    pattern: z
      .string()
      .optional()
      .describe("Case-insensitive substring, or a LIKE pattern when it contains %"),
    include_views: z.boolean().optional().describe("Include views (default true)"),
    limit: z.number().int().min(1).max(5000).optional(),
  },
  table_describe: { connection, schema, table },
  table_sample: {
    connection,
    schema,
    table,
    limit: z.number().int().min(1).max(1000).optional().describe("Rows (default 10)"),
  },
  columns_search: {
    connection,
    pattern: z.string().min(1).describe("Column name substring, or LIKE pattern with %"),
    schema,
    limit: z.number().int().min(1).max(5000).optional(),
  },
  sql_query: { connection, sql, params, max_rows: maxRows },
  sql_explain: { connection, sql, params },
  sql_execute: { connection, sql, params, max_rows: maxRows },
} as const;

export type ToolName = keyof typeof TOOL_SHAPES;

export const TOOL_NAMES = Object.keys(TOOL_SHAPES) as ToolName[];

/** Tools only registered when at least one connection is read_write or admin. */
export const WRITE_TOOLS = new Set<ToolName>(["sql_execute"]);

export const TOOL_DESCRIPTIONS: Record<ToolName, string> = {
  connections_list:
    "List configured database connections with engine (postgres/bigquery), access level (read_only/read_write/admin) and the default connection.",
  connection_info:
    "Check a connection and return server details: version, database/project, current user, effective read-only state.",
  schemas_list: "List Postgres schemas or BigQuery datasets.",
  tables_list:
    "List tables and views (with kind, estimated rows, size) in a schema/dataset, optionally filtered by name.",
  table_describe:
    "Describe a table or view: columns (type, nullable, default, comment), primary/foreign keys, indexes, partitioning, view definition.",
  table_sample: "Return the first N rows of a table or view (read-only).",
  columns_search: "Find columns by name across tables to locate where data lives.",
  sql_query:
    "Run one read-only SQL statement (SELECT/WITH/VALUES/SHOW/EXPLAIN). Always read-only, whatever the connection access. Results are capped at max_rows.",
  sql_explain:
    "Show the query plan without executing (Postgres EXPLAIN FORMAT JSON) or dry-run cost (BigQuery bytes processed, statement type).",
  sql_execute:
    "Run one SQL statement allowed by the connection access: read_write = SELECT + INSERT/UPDATE/DELETE/MERGE; admin = anything including DDL and multi-statement scripts.",
};

export const READ_ONLY_TOOLS = new Set<ToolName>(TOOL_NAMES.filter((t) => !WRITE_TOOLS.has(t)));

export const toolSchemas = Object.fromEntries(
  TOOL_NAMES.map((name) => [name, z.object(TOOL_SHAPES[name]).strict()]),
) as { [K in ToolName]: z.ZodObject<(typeof TOOL_SHAPES)[K]> };

export type ToolArgs<K extends ToolName> = z.infer<(typeof toolSchemas)[K]>;
