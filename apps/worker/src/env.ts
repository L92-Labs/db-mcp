import type { EnvMap } from "@db-mcp/core";

export type WorkerEnv = {
  MCP_BEARER_TOKEN?: string;
  DB_CONNECTIONS_JSON?: string;
  DB_DEFAULT_CONNECTION?: string;
  DB_ACCESS?: string;
  DB_MAX_ROWS?: string;
  DB_STATEMENT_TIMEOUT_MS?: string;
  DATABASE_URL?: string;
  DATABASE_ACCESS?: string;
  DATABASE_SSL?: string;
  BIGQUERY_PROJECT_ID?: string;
  BIGQUERY_LOCATION?: string;
  BIGQUERY_CREDENTIALS_JSON?: string;
  BIGQUERY_ACCESS_TOKEN?: string;
  BIGQUERY_DEFAULT_DATASET?: string;
  BIGQUERY_MAX_BYTES_BILLED?: string;
  BIGQUERY_ACCESS?: string;
  HYPERDRIVE?: Hyperdrive;
  [binding: string]: unknown;
};

/** String vars only; Hyperdrive bindings are resolved separately by name. */
export function envToMap(env: WorkerEnv): EnvMap {
  const map: EnvMap = {};
  for (const [k, v] of Object.entries(env)) if (typeof v === "string") map[k] = v;
  // Default Hyperdrive binding → shorthand postgres connection.
  if (!map.DATABASE_URL && isHyperdrive(env.HYPERDRIVE)) map.DATABASE_HYPERDRIVE = "HYPERDRIVE";
  return map;
}

export function isHyperdrive(value: unknown): value is Hyperdrive {
  return (
    typeof value === "object" && value !== null && typeof (value as Hyperdrive).connectionString === "string"
  );
}
