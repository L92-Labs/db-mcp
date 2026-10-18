import type {
  AccessLevel,
  AuditMode,
  BigQueryConnection,
  ConnectionConfig,
  MySqlConnection,
  PostgresConnection,
  RuntimeConfig,
} from "./types.js";

export type EnvMap = Record<string, string | undefined>;

const ACCESS_ALIASES: Record<string, AccessLevel> = {
  read_only: "read_only",
  readonly: "read_only",
  "read-only": "read_only",
  ro: "read_only",
  read: "read_only",
  read_write: "read_write",
  readwrite: "read_write",
  "read-write": "read_write",
  rw: "read_write",
  write: "read_write",
  admin: "admin",
  full: "admin",
  ddl: "admin",
};

export function parseAccess(value: string | undefined, fallback: AccessLevel): AccessLevel {
  if (value === undefined || value.trim() === "") return fallback;
  const access = ACCESS_ALIASES[value.trim().toLowerCase()];
  if (!access) {
    throw new Error(`access must be read_only, read_write or admin, got: ${value}`);
  }
  return access;
}

function parseIntInRange(
  value: string | undefined,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}, got: ${value}`);
  }
  return n;
}

function parseSsl(value: unknown): PostgresConnection["ssl"] {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "boolean") return value;
  const v = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on", "require", "verify-full"].includes(v)) return "require";
  if (["no-verify", "allow", "prefer"].includes(v)) return "no-verify";
  if (["0", "false", "no", "off", "disable"].includes(v)) return false;
  throw new Error(`invalid ssl option: ${String(value)}`);
}

type RawConnection = {
  engine?: string;
  type?: string;
  access?: string;
  description?: string;
  url?: string;
  connection_string?: string;
  hyperdrive?: string;
  ssl?: boolean | string;
  project_id?: string;
  projectId?: string;
  location?: string;
  credentials_json?: string | Record<string, unknown>;
  credentialsJson?: string | Record<string, unknown>;
  access_token?: string;
  accessToken?: string;
  default_dataset?: string;
  defaultDataset?: string;
  max_bytes_billed?: string | number;
  maxBytesBilled?: string | number;
  schemas?: string[] | string;
  hidden_columns?: string[] | string;
  hiddenColumns?: string[] | string;
};

function parseList(value: string[] | string | undefined, name: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  const list = Array.isArray(value) ? value : String(value).split(",");
  const out = list.map((v) => {
    if (typeof v !== "string") throw new Error(`${name} must be a list of strings`);
    return v.trim();
  });
  const filtered = out.filter(Boolean);
  return filtered.length > 0 ? filtered : undefined;
}

function normalizeConnection(name: string, raw: RawConnection, defaultAccess: AccessLevel): ConnectionConfig {
  const engine = (raw.engine ?? raw.type ?? "").trim().toLowerCase();
  const access = parseAccess(raw.access, defaultAccess);
  const description = raw.description?.trim() || undefined;
  const policy = {
    schemas: parseList(raw.schemas, `connection "${name}" schemas`),
    hiddenColumns: parseList(raw.hidden_columns ?? raw.hiddenColumns, `connection "${name}" hidden_columns`),
  };

  const sqlEngine =
    engine === "postgres" || engine === "postgresql" || engine === "pg"
      ? "postgres"
      : engine === "mysql" || engine === "mariadb"
        ? "mysql"
        : null;
  if (sqlEngine) {
    const url = (raw.url ?? raw.connection_string)?.trim() || undefined;
    const hyperdrive = raw.hyperdrive?.trim() || undefined;
    if (!url && !hyperdrive) {
      throw new Error(`connection "${name}" (${sqlEngine}) requires url or hyperdrive`);
    }
    return {
      name,
      engine: sqlEngine,
      access,
      description,
      ...policy,
      url,
      hyperdrive,
      ssl: parseSsl(raw.ssl),
    };
  }

  if (engine === "bigquery" || engine === "bq") {
    const projectId = (raw.project_id ?? raw.projectId)?.trim();
    if (!projectId) throw new Error(`connection "${name}" (bigquery) requires project_id`);
    const creds = raw.credentials_json ?? raw.credentialsJson;
    const credentialsJson =
      creds === undefined ? undefined : typeof creds === "string" ? creds : JSON.stringify(creds);
    const accessToken = (raw.access_token ?? raw.accessToken)?.trim() || undefined;
    if (!credentialsJson && !accessToken) {
      throw new Error(`connection "${name}" (bigquery) requires credentials_json or access_token`);
    }
    const maxBytes = raw.max_bytes_billed ?? raw.maxBytesBilled;
    return {
      name,
      engine: "bigquery",
      access,
      description,
      ...policy,
      projectId,
      location: raw.location?.trim() || undefined,
      credentialsJson,
      accessToken,
      defaultDataset: (raw.default_dataset ?? raw.defaultDataset)?.trim() || undefined,
      maxBytesBilled: maxBytes === undefined || maxBytes === "" ? undefined : String(maxBytes),
    };
  }

  throw new Error(`connection "${name}" has unknown engine "${engine}" (use postgres, mysql or bigquery)`);
}

function loadFromJson(env: EnvMap, defaultAccess: AccessLevel): Record<string, ConnectionConfig> | null {
  const json = env.DB_CONNECTIONS_JSON?.trim();
  if (!json) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new Error(`DB_CONNECTIONS_JSON is not valid JSON: ${(err as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("DB_CONNECTIONS_JSON must be an object of named connections");
  }
  const out: Record<string, ConnectionConfig> = {};
  for (const [name, value] of Object.entries(parsed as Record<string, RawConnection>)) {
    out[name] = normalizeConnection(name, value ?? {}, defaultAccess);
  }
  if (Object.keys(out).length === 0) throw new Error("DB_CONNECTIONS_JSON has no connections");
  return out;
}

/** Shorthand env: DATABASE_URL / DATABASE_HYPERDRIVE (postgres) and BIGQUERY_* (bigquery). */
function loadShorthand(env: EnvMap, defaultAccess: AccessLevel): Record<string, ConnectionConfig> | null {
  const out: Record<string, ConnectionConfig> = {};
  const url = env.DATABASE_URL?.trim();
  const hyperdrive = env.DATABASE_HYPERDRIVE?.trim();
  if (url || hyperdrive) {
    out.postgres = normalizeConnection(
      "postgres",
      {
        engine: "postgres",
        url,
        hyperdrive: url ? undefined : hyperdrive,
        ssl: env.DATABASE_SSL,
        access: env.DATABASE_ACCESS,
        schemas: env.DATABASE_SCHEMAS,
        hidden_columns: env.DATABASE_HIDDEN_COLUMNS,
      },
      defaultAccess,
    );
  }
  const mysqlUrl = env.MYSQL_URL?.trim();
  const mysqlHyperdrive = env.MYSQL_HYPERDRIVE?.trim();
  if (mysqlUrl || mysqlHyperdrive) {
    out.mysql = normalizeConnection(
      "mysql",
      {
        engine: "mysql",
        url: mysqlUrl,
        hyperdrive: mysqlUrl ? undefined : mysqlHyperdrive,
        ssl: env.MYSQL_SSL,
        access: env.MYSQL_ACCESS,
        schemas: env.MYSQL_SCHEMAS,
        hidden_columns: env.MYSQL_HIDDEN_COLUMNS,
      },
      defaultAccess,
    );
  }
  if (env.BIGQUERY_PROJECT_ID?.trim()) {
    out.bigquery = normalizeConnection(
      "bigquery",
      {
        engine: "bigquery",
        project_id: env.BIGQUERY_PROJECT_ID,
        location: env.BIGQUERY_LOCATION,
        credentials_json: env.BIGQUERY_CREDENTIALS_JSON,
        access_token: env.BIGQUERY_ACCESS_TOKEN,
        default_dataset: env.BIGQUERY_DEFAULT_DATASET,
        max_bytes_billed: env.BIGQUERY_MAX_BYTES_BILLED,
        access: env.BIGQUERY_ACCESS,
        schemas: env.BIGQUERY_DATASETS,
        hidden_columns: env.BIGQUERY_HIDDEN_COLUMNS,
      },
      defaultAccess,
    );
  }
  return Object.keys(out).length > 0 ? out : null;
}

export function loadRuntimeConfig(
  env: EnvMap = (typeof process !== "undefined" ? process.env : {}) as EnvMap,
): RuntimeConfig {
  const defaultAccess = parseAccess(env.DB_ACCESS, "read_only");
  const connections = loadFromJson(env, defaultAccess) ?? loadShorthand(env, defaultAccess);
  if (!connections) {
    throw new Error(
      "Configure DB_CONNECTIONS_JSON, DATABASE_URL (or a Hyperdrive binding), MYSQL_URL or BIGQUERY_PROJECT_ID. See .env.example",
    );
  }

  // DB_HIDDEN_COLUMNS applies to every connection, on top of its own hidden_columns.
  const globalHidden = parseList(env.DB_HIDDEN_COLUMNS, "DB_HIDDEN_COLUMNS");
  if (globalHidden) {
    for (const c of Object.values(connections)) {
      c.hiddenColumns = [...new Set([...(c.hiddenColumns ?? []), ...globalHidden])];
    }
  }

  const names = Object.keys(connections);
  const defaultConnection = env.DB_DEFAULT_CONNECTION?.trim() || names[0]!;
  if (!connections[defaultConnection]) {
    throw new Error(`DB_DEFAULT_CONNECTION "${defaultConnection}" not found. Known: ${names.join(", ")}`);
  }

  return {
    connections,
    defaultConnection,
    maxRows: parseIntInRange(env.DB_MAX_ROWS, "DB_MAX_ROWS", 200, 1, 10_000),
    statementTimeoutMs: parseIntInRange(
      env.DB_STATEMENT_TIMEOUT_MS,
      "DB_STATEMENT_TIMEOUT_MS",
      30_000,
      100,
      600_000,
    ),
    maxResultBytes: parseIntInRange(
      env.DB_MAX_RESULT_BYTES,
      "DB_MAX_RESULT_BYTES",
      100_000,
      1_000,
      50_000_000,
    ),
    maxCellChars: parseIntInRange(env.DB_MAX_CELL_CHARS, "DB_MAX_CELL_CHARS", 2_000, 16, 10_000_000),
    audit: parseAudit(env.DB_AUDIT_LOG),
    mcpBearerToken: env.MCP_BEARER_TOKEN?.trim() || undefined,
  };
}

function parseAudit(value: string | undefined): AuditMode {
  const v = (value ?? "meta").trim().toLowerCase();
  if (v === "off" || v === "meta" || v === "sql") return v;
  if (["0", "false", "no", "none"].includes(v)) return "off";
  throw new Error(`DB_AUDIT_LOG must be off, meta or sql, got: ${value}`);
}

const ACCESS_RANK: Record<AccessLevel, number> = { read_only: 0, read_write: 1, admin: 2 };

/** Lower every connection to at most `max` (e.g. an OAuth token without db:write). */
export function capAccess(config: RuntimeConfig, max: AccessLevel): RuntimeConfig {
  const connections: Record<string, ConnectionConfig> = {};
  for (const [name, c] of Object.entries(config.connections)) {
    connections[name] = ACCESS_RANK[c.access] > ACCESS_RANK[max] ? { ...c, access: max } : c;
  }
  return { ...config, connections };
}

export function resolveConnection(config: RuntimeConfig, name?: string): ConnectionConfig {
  const key = name?.trim() || config.defaultConnection;
  const connection = config.connections[key];
  if (!connection) {
    throw new Error(`unknown connection "${key}". Known: ${Object.keys(config.connections).join(", ")}`);
  }
  return connection;
}

export function anyWritable(config: RuntimeConfig): boolean {
  return Object.values(config.connections).some((c) => c.access !== "read_only");
}

export type { BigQueryConnection, MySqlConnection, PostgresConnection };
