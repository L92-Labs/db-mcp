import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";
import {
  authorizeBearer,
  buildMcpServer,
  capAccess,
  consoleSink,
  createDispatchContext,
  enabledTools,
  loadRuntimeConfig,
} from "@db-mcp/core";
import { workerAdapterFactory } from "./adapters.js";
import { envToMap, type WorkerEnv } from "./env.js";
import { oauthProvider, type McpCaller } from "./oauth.js";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
  "access-control-allow-headers": "Authorization,Content-Type,Accept,Mcp-Session-Id,Mcp-Protocol-Version",
  "access-control-expose-headers": "Mcp-Session-Id,WWW-Authenticate",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS },
  });
}

function isMcpPath(pathname: string): boolean {
  return pathname === "/mcp" || pathname.startsWith("/mcp/");
}

/** Run one stateless MCP request; the caller is already authenticated. */
async function handleMcp(request: Request, env: WorkerEnv, caller: McpCaller): Promise<Response> {
  try {
    const config = capAccess(loadRuntimeConfig(envToMap(env)), caller.maxAccess);
    const ctx = createDispatchContext(config, workerAdapterFactory(env));
    const server = buildMcpServer(ctx, {
      jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
      principal: caller.principal,
      audit: consoleSink,
    });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    const response = await transport.handleRequest(request);
    const headers = new Headers(response.headers);
    for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
    return new Response(response.body, { status: response.status, headers });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "error" }, 500);
  }
}

function authMode(env: WorkerEnv): "bearer" | "oauth" {
  const mode = (env.AUTH_MODE ?? "bearer").trim().toLowerCase();
  if (mode !== "bearer" && mode !== "oauth")
    throw new Error(`AUTH_MODE must be bearer or oauth, got: ${mode}`);
  return mode;
}

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    if (url.pathname === "/health") {
      try {
        const config = loadRuntimeConfig(envToMap(env));
        return json({
          ok: true,
          auth: authMode(env),
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
    if (url.pathname === "/")
      return json({ name: "db-mcp", mcp: "/mcp", health: "/health", auth: authMode(env) });

    // The static bearer token always works (CLI clients, scripts) when set.
    const staticBearer =
      isMcpPath(url.pathname) && authorizeBearer(env.MCP_BEARER_TOKEN, request.headers.get("authorization"));
    if (staticBearer) return handleMcp(request, env, { principal: "bearer", maxAccess: "admin" });

    if (authMode(env) === "oauth") {
      if (!env.OAUTH_KV)
        return json({ error: "AUTH_MODE=oauth needs a KV namespace bound as OAUTH_KV" }, 500);
      return oauthProvider(url.origin, handleMcp).fetch(request, env, ctx);
    }

    if (isMcpPath(url.pathname)) return json({ error: "unauthorized" }, 401);
    return json({ error: "not_found" }, 404);
  },
} satisfies ExportedHandler<WorkerEnv>;
