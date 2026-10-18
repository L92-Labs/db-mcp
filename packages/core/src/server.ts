import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { jsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/types.js";
import { dispatchTool, enabledTools, type DispatchContext } from "./dispatch.js";
import { errorToolResult, jsonToolResult } from "./format.js";
import { TOOL_DESCRIPTIONS, TOOL_SHAPES, WRITE_TOOLS } from "./tools.js";

export const SERVER_NAME = "db-mcp";
export const SERVER_VERSION = "0.1.0";

function instructions(ctx: DispatchContext): string {
  const lines = Object.values(ctx.config.connections).map(
    (c) =>
      `- ${c.name}${c.name === ctx.config.defaultConnection ? " (default)" : ""}: ${c.engine}, ${c.access}${c.description ? ` — ${c.description}` : ""}`,
  );
  return [
    "Database access over MCP. Explore with schemas_list → tables_list → table_describe / table_sample / columns_search, then sql_query.",
    "sql_query is always read-only. sql_execute (when present) runs writes up to each connection's access level.",
    "Postgres binds $1, $2… from params[]; BigQuery binds ? from params[] or @name from params{}.",
    "Connections:",
    ...lines,
  ].join("\n");
}

export function buildMcpServer(
  ctx: DispatchContext,
  opts: { jsonSchemaValidator?: jsonSchemaValidator } = {},
): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: instructions(ctx), jsonSchemaValidator: opts.jsonSchemaValidator },
  );

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
        try {
          return jsonToolResult(await dispatchTool(name, args ?? {}, ctx));
        } catch (error) {
          return errorToolResult(error);
        }
      },
    );
  }
  return server;
}
