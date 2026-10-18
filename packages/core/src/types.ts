export type Engine = "postgres" | "bigquery" | "mysql";

/** What a connection is allowed to run. Ordered: read_only < read_write < admin. */
export type AccessLevel = "read_only" | "read_write" | "admin";

/** What a single SQL statement needs. Ordered: read < write < admin. */
export type StatementClass = "read" | "write" | "admin";

type BaseConnection = {
  name: string;
  access: AccessLevel;
  description?: string;
  /** Allowlist of schemas (Postgres/MySQL) or datasets (BigQuery). Unset = all. */
  schemas?: string[];
  /** Column patterns hidden from agents: "password", "users.ssn", "public.users.*token*". */
  hiddenColumns?: string[];
};

export type PostgresConnection = BaseConnection & {
  engine: "postgres";
  /** postgres://… connection string (Node, or Workers without Hyperdrive). */
  url?: string;
  /** Workers only: name of the Hyperdrive binding (e.g. "HYPERDRIVE"). */
  hyperdrive?: string;
  /** TLS: true / "require" = verify, "no-verify" = encrypt without verification, false = off. */
  ssl?: boolean | "require" | "no-verify";
};

export type BigQueryConnection = BaseConnection & {
  engine: "bigquery";
  projectId: string;
  /** Job location, e.g. "US", "EU", "europe-west1". Required for region-wide INFORMATION_SCHEMA. */
  location?: string;
  /** Service-account key JSON (raw or base64). */
  credentialsJson?: string;
  /** Static OAuth access token (short-lived; for local testing). */
  accessToken?: string;
  defaultDataset?: string;
  /** Hard cap on bytes billed per query (string int64). */
  maxBytesBilled?: string;
};

export type MySqlConnection = BaseConnection & {
  engine: "mysql";
  /** mysql://… connection string (Node, or Workers without Hyperdrive). */
  url?: string;
  /** Workers only: name of the Hyperdrive binding. */
  hyperdrive?: string;
  ssl?: boolean | "require" | "no-verify";
};

export type ConnectionConfig = PostgresConnection | BigQueryConnection | MySqlConnection;

export type AuditMode = "off" | "meta" | "sql";

export type RuntimeConfig = {
  connections: Record<string, ConnectionConfig>;
  defaultConnection: string;
  maxRows: number;
  statementTimeoutMs: number;
  /** Cap on the JSON size of returned rows (bytes). */
  maxResultBytes: number;
  /** Longer string cells are cut to this many characters. */
  maxCellChars: number;
  audit: AuditMode;
  mcpBearerToken?: string;
};

export type ColumnMeta = { name: string; type: string };

export type QueryResult = {
  columns: ColumnMeta[];
  rows: Record<string, unknown>[];
  row_count: number;
  truncated: boolean;
  /** Rows changed by DML, when the engine reports it. */
  affected_rows?: number | null;
  command?: string;
  statement_class: StatementClass;
  duration_ms?: number;
  [extra: string]: unknown;
};

export type SqlParams = unknown[] | Record<string, unknown>;

export type RunInput = {
  sql: string;
  params?: SqlParams;
  maxRows: number;
  timeoutMs: number;
  /** Highest statement class this call may execute; the adapter must enforce it engine-side too. */
  allow: StatementClass;
  /** Class the local classifier computed (adapters may refine it, e.g. BigQuery dry run). */
  classified: StatementClass;
  /** Run, report, then roll back (BigQuery: dry-run job only). */
  dryRun?: boolean;
};

export type TableRef = { schema?: string; table: string };

export type ListTablesInput = {
  schema?: string;
  pattern?: string;
  includeViews: boolean;
  limit: number;
};

export type SearchColumnsInput = {
  pattern: string;
  schema?: string;
  limit: number;
};

/** One engine connection. Implementations own their own pooling / per-call clients. */
export interface DbAdapter {
  readonly engine: Engine;
  info(): Promise<Record<string, unknown>>;
  listSchemas(input: { includeSystem: boolean }): Promise<Record<string, unknown>[]>;
  listTables(input: ListTablesInput): Promise<Record<string, unknown>[]>;
  describeTable(ref: TableRef): Promise<Record<string, unknown>>;
  /** First rows; adapters select only columns the policy does not hide. */
  sampleTable(ref: TableRef, limit: number, timeoutMs: number): Promise<QueryResult>;
  searchColumns(input: SearchColumnsInput): Promise<Record<string, unknown>[]>;
  run(input: RunInput): Promise<QueryResult>;
  explain(input: { sql: string; params?: SqlParams; timeoutMs: number }): Promise<Record<string, unknown>>;
  close?(): Promise<void>;
}

export type AdapterFactory = (connection: ConnectionConfig, config: RuntimeConfig) => DbAdapter;
