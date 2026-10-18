import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  authorizeBearer,
  buildMcpServer,
  createDispatchContext,
  enabledTools,
  type DispatchContext,
  type RuntimeConfig,
} from "@db-mcp/core";
import { nodeAdapterFactory } from "./adapters.js";

export async function startStdio(config: RuntimeConfig): Promise<void> {
  const ctx = createDispatchContext(config, nodeAdapterFactory);
  await buildMcpServer(ctx, { principal: "stdio" }).connect(new StdioServerTransport());
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export async function startHttp(
  config: RuntimeConfig,
  port: number,
): Promise<ReturnType<typeof createServer>> {
  // Adapters (and their pools) live for the process; MCP server/transport are per request.
  const ctx = createDispatchContext(config, nodeAdapterFactory);

  const server = createServer(async (req, res) => {
    try {
      await handleHttp(req, res, ctx);
    } catch (error) {
      if (!res.headersSent) json(res, 500, { error: error instanceof Error ? error.message : "error" });
    }
  });

  await new Promise<void>((resolve) => server.listen(port, resolve));
  console.error(`db-mcp HTTP listening on :${port} (/mcp)`);
  return server;
}

async function handleHttp(req: IncomingMessage, res: ServerResponse, ctx: DispatchContext): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (req.method === "GET" && url.pathname === "/health") {
    json(res, 200, {
      ok: true,
      connections: Object.values(ctx.config.connections).map((c) => ({
        name: c.name,
        engine: c.engine,
        access: c.access,
      })),
      tools: enabledTools(ctx.config),
    });
    return;
  }

  if (url.pathname !== "/mcp" && !url.pathname.startsWith("/mcp/")) {
    json(res, 404, { error: "not_found" });
    return;
  }

  if (!authorizeBearer(ctx.config.mcpBearerToken, req.headers.authorization)) {
    json(res, 401, { error: "unauthorized" });
    return;
  }

  // Stateless Streamable HTTP: one transport + MCP server per request.
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  const mcp = buildMcpServer(ctx, { principal: "bearer" });
  res.on("close", () => {
    void transport.close();
    void mcp.close();
  });
  await mcp.connect(transport);

  const bodyRaw = req.method === "POST" ? await readBody(req) : undefined;
  let parsedBody: unknown;
  if (bodyRaw) {
    try {
      parsedBody = JSON.parse(bodyRaw);
    } catch {
      json(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null });
      return;
    }
  }
  await transport.handleRequest(req, res, parsedBody);
}
