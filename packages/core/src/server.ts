import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { jsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/types.js";
import { buildAuditEntry, stderrSink, type AuditSink } from "./audit.js";
import { dispatchTool, enabledTools, type DispatchContext } from "./dispatch.js";
import { errorToolResult, jsonToolResult } from "./format.js";
import { TOOL_DESCRIPTIONS, TOOL_SHAPES, WRITE_TOOLS } from "./tools.js";

export const SERVER_NAME = "db-mcp";
export const SERVER_VERSION = "0.1.0";

function instructions(ctx: DispatchContext): string {
  const lines = Object.values(ctx.config.connections).map(
    (c) =>
      `- ${c.name}${c.name === ctx.config.defaultConnection ? " (default)" : ""}: ${c.engine}, ${c.access}${c.schemas?.length ? `, schemas: ${c.schemas.join("/")}` : ""}${c.hiddenColumns?.length ? `, hidden columns: ${c.hiddenColumns.join("/")}` : ""}${c.description ? ` — ${c.description}` : ""}`,
  );
  return [
    "Database access over MCP. Explore with schemas_list → tables_list → table_describe / table_sample / columns_search, then sql_query.",
    "sql_query is always read-only. sql_execute (when present) runs writes up to each connection's access level.",
    "Postgres binds $1, $2… from params[]; MySQL binds ? from params[]; BigQuery binds ? from params[] or @name from params{}.",
    "Before a write, sql_execute with dry_run: true shows the affected rows and rolls back.",
    "Results are capped by rows and bytes; when truncated, narrow the query (WHERE, LIMIT, fewer columns).",
    "Connections:",
    ...lines,
  ].join("\n");
}

export type BuildServerOptions = {
  jsonSchemaValidator?: jsonSchemaValidator;
  /** Who is calling (audit log): "stdio", "bearer", "github:login"… */
  principal?: string;
  audit?: AuditSink;
};

export function buildMcpServer(ctx: DispatchContext, opts: BuildServerOptions = {}): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: instructions(ctx), jsonSchemaValidator: opts.jsonSchemaValidator },
  );
  const principal = opts.principal ?? "unknown";
  const sink = opts.audit ?? stderrSink;

  const audit = async (
    tool: string,
    args: Record<string, unknown>,
    startedAt: number,
    result?: unknown,
    error?: unknown,
  ) => {
    if (ctx.config.audit === "off") return;
    try {
      sink(
        await buildAuditEntry({
          mode: ctx.config.audit,
          principal,
          tool,
          args,
          result: result as Record<string, unknown> | undefined,
          error,
          startedAt,
          defaultConnection: ctx.config.defaultConnection,
        }),
      );
    } catch {
      // never fail a tool call because of logging
    }
  };

  for (const name of enabledTools(ctx.config)) {
    const write = WRITE_TOOLS.has(name);
    server.registerTool(
      name,
      {
        description: TOOL_DESCRIPTIONS[name],
        inputSchema: TOOL_SHAPES[name],
        annotations: {
          readOnlyHint: !write,
          destructiveHint: write,
          idempotentHint: !write,
          openWorldHint: false,
        },
      },
      async (args: unknown) => {
        const input = (args ?? {}) as Record<string, unknown>;
        const startedAt = Date.now();
        try {
          const result = await dispatchTool(name, input, ctx);
          await audit(name, input, startedAt, result);
          return jsonToolResult(result);
        } catch (error) {
          await audit(name, input, startedAt, undefined, error);
          return errorToolResult(error);
        }
      },
    );
  }
  return server;
}
