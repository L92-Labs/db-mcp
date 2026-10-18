import type { EnvMap } from "@db-mcp/core";
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export type WorkerEnv = {
  MCP_BEARER_TOKEN?: string;
  DB_CONNECTIONS_JSON?: string;
  DB_DEFAULT_CONNECTION?: string;
  DB_ACCESS?: string;
  DATABASE_URL?: string;
  MYSQL_URL?: string;
  MYSQL_HYPERDRIVE?: string;
  BIGQUERY_PROJECT_ID?: string;
  /** "bearer" (default) or "oauth" */
  AUTH_MODE?: string;
  /** "github" or "password" */
  OAUTH_LOGIN?: string;
  OAUTH_PASSWORD?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  /** Comma-separated GitHub logins allowed to sign in. */
  OAUTH_ALLOWED_USERS?: string;
  OAUTH_KV?: KVNamespace;
  OAUTH_PROVIDER?: OAuthHelpers;
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
