import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";
import {
  authorizeBearer,
  buildMcpServer,
  createDispatchContext,
  enabledTools,
  loadRuntimeConfig,
} from "@db-mcp/core";
import { workerAdapterFactory } from "./adapters.js";
import { envToMap, type WorkerEnv } from "./env.js";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
  "access-control-allow-headers": "Authorization,Content-Type,Accept,Mcp-Session-Id,Mcp-Protocol-Version",
  "access-control-expose-headers": "Mcp-Session-Id",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS },
  });
}

async function handleMcp(request: Request, env: WorkerEnv): Promise<Response> {
  const config = loadRuntimeConfig(envToMap(env));
  if (!authorizeBearer(config.mcpBearerToken, request.headers.get("authorization"))) {
    return json({ error: "unauthorized" }, 401);
  }
  const ctx = createDispatchContext(config, workerAdapterFactory(env));
  const server = buildMcpServer(ctx, { jsonSchemaValidator: new CfWorkerJsonSchemaValidator() });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  const response = await transport.handleRequest(request);
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
  return new Response(response.body, { status: response.status, headers });
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
      try {
        return await handleMcp(request, env);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "error" }, 500);
      }
    }

    if (url.pathname === "/health") {
      try {
        const config = loadRuntimeConfig(envToMap(env));
        return json({
          ok: true,
          connections: Object.values(config.connections).map((c) => ({
            name: c.name,
            engine: c.engine,
            access: c.access,
          })),
          tools: enabledTools(config),
        });
      } catch (error) {
        return json({ ok: false, error: error instanceof Error ? error.message : "config_error" }, 500);
      }
    }

    if (url.pathname === "/") return json({ name: "db-mcp", mcp: "/mcp", health: "/health" });
    return json({ error: "not_found" }, 404);
  },
} satisfies ExportedHandler<WorkerEnv>;
