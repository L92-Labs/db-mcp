import type { AuditMode } from "./types.js";

export type AuditEntry = {
  ts: string;
  event: "db_mcp.tool";
  principal: string;
  tool: string;
  ok: boolean;
  duration_ms: number;
  connection?: string;
  engine?: string;
  statement_class?: string;
  command?: string;
  rows?: number;
  affected_rows?: number | null;
  truncated?: boolean;
  dry_run?: boolean;
  bytes_processed?: number | null;
  sql_sha256?: string;
  sql?: string;
  error?: string;
};

export type AuditSink = (entry: AuditEntry) => void;

/** JSON lines. Node: stderr (stdout carries stdio MCP). Workers: console.log → Workers Logs. */
export const stderrSink: AuditSink = (entry) => {
  const g = globalThis as { process?: { stderr?: { write(s: string): void } } };
  if (g.process?.stderr) g.process.stderr.write(`${JSON.stringify(entry)}\n`);
  else console.log(JSON.stringify(entry));
};

export const consoleSink: AuditSink = (entry) => console.log(JSON.stringify(entry));

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

const MAX_AUDIT_SQL = 4_000;

export async function buildAuditEntry(opts: {
  mode: AuditMode;
  principal: string;
  tool: string;
  args: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: unknown;
  startedAt: number;
}): Promise<AuditEntry> {
  const { args, result } = opts;
  const sql = typeof args.sql === "string" ? args.sql : undefined;
  const entry: AuditEntry = {
    ts: new Date().toISOString(),
    event: "db_mcp.tool",
    principal: opts.principal,
    tool: opts.tool,
    ok: opts.error === undefined,
    duration_ms: Date.now() - opts.startedAt,
  };
  const connection = (result?.connection ?? args.connection) as string | undefined;
  if (connection) entry.connection = connection;
  if (result) {
    if (typeof result.statement_class === "string") entry.statement_class = result.statement_class;
    if (typeof result.command === "string") entry.command = result.command;
    if (typeof result.row_count === "number") entry.rows = result.row_count;
    if (result.affected_rows !== undefined) entry.affected_rows = result.affected_rows as number | null;
    if (typeof result.truncated === "boolean") entry.truncated = result.truncated;
    if (result.dry_run === true) entry.dry_run = true;
    if (result.bytes_processed !== undefined) entry.bytes_processed = result.bytes_processed as number | null;
  }
  if (sql) {
    entry.sql_sha256 = await sha256(sql);
    if (opts.mode === "sql") entry.sql = sql.length > MAX_AUDIT_SQL ? `${sql.slice(0, MAX_AUDIT_SQL)}…` : sql;
  }
  if (opts.error !== undefined) {
    entry.error = (opts.error instanceof Error ? opts.error.message : String(opts.error)).slice(0, 500);
  }
  return entry;
}
