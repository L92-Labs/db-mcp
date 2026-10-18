import {
  AuthorizationError,
  CimdFetchError,
  OAuthProvider,
  authorizationErrorRedirect,
  insufficientScope,
  type ConsentDescription,
  type OAuthResourceAuth,
  type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import type { AccessLevel } from "@db-mcp/core";
import type { WorkerEnv } from "./env.js";

/**
 * OAuth 2.1 for remote MCP clients (claude.ai, ChatGPT, Cursor…): this Worker is the
 * authorization server. Sign-in is GitHub (allowlisted logins) or a shared password.
 * Scopes: db:read (always) and db:write (needed for sql_execute).
 */

export const SCOPES = ["db:read", "db:write"] as const;

export type AuthProps = { principal: string; provider: "github" | "password" };

export type McpCaller = { principal: string; maxAccess: AccessLevel };

type McpHandler = (request: Request, env: WorkerEnv, caller: McpCaller) => Promise<Response>;

const providers = new Map<string, OAuthProvider<WorkerEnv>>();

/** One provider per origin: the resource URL must be the canonical https origin (or loopback in dev). */
export function oauthProvider(origin: string, handleMcp: McpHandler): OAuthProvider<WorkerEnv> {
  let provider = providers.get(origin);
  if (provider) return provider;
  provider = new OAuthProvider<WorkerEnv>({
    apiRoute: "/mcp",
    apiHandler: {
      async fetch(request, env, ctx) {
        const { props, auth } = ctx as unknown as { props: AuthProps; auth: OAuthResourceAuth };
        // requiredScopes is only advertised by the library: enforce it here.
        if (!auth?.scope?.includes("db:read")) return insufficientScope(auth, ["db:read"]);
        return handleMcp(request, env as WorkerEnv, {
          principal: props?.principal ?? "oauth",
          maxAccess: auth?.scope?.includes("db:write") ? "admin" : "read_only",
        });
      },
    },
    defaultHandler: { fetch: (request, env) => authorizeApp(request, env as WorkerEnv) },
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/oauth/register",
    scopesSupported: [...SCOPES, "offline_access"],
    requiredScopes: ["db:read"],
    resourceMetadata: { resource: `${origin}/mcp`, authorization_servers: [origin] },
    clientIdMetadataDocumentEnabled: true,
    accessTokenTTL: 3600,
  });
  providers.set(origin, provider);
  return provider;
}

const escape = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(title: string, body: string, headers = new Headers(), status = 200): Response {
  headers.set("content-type", "text/html; charset=utf-8");
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(title)}</title>
<style>
  :root { color-scheme: light dark; --fg:#0a0a0a; --muted:#666; --border:#e5e5e5; --bg:#fff; --accent:#0a0a0a; }
  @media (prefers-color-scheme: dark) { :root { --fg:#ededed; --muted:#a1a1a1; --border:#2e2e2e; --bg:#0a0a0a; --accent:#ededed; } }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:var(--bg); color:var(--fg);
         font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { width:min(420px, 92vw); border:1px solid var(--border); border-radius:12px; padding:28px; }
  h1 { font-size:18px; margin:0 0 6px; } p { margin:0 0 14px; color:var(--muted); }
  strong { color:var(--fg); } .warn { color:#b45309; }
  fieldset { border:1px solid var(--border); border-radius:8px; padding:10px 14px; margin:0 0 16px; }
  label { display:flex; gap:8px; align-items:flex-start; padding:4px 0; } label small { display:block; color:var(--muted); }
  input[type=password] { width:100%; padding:9px 10px; border:1px solid var(--border); border-radius:8px; background:transparent; color:var(--fg); margin:0 0 16px; font:inherit; }
  .row { display:flex; gap:8px; justify-content:flex-end; }
  button { font:inherit; padding:8px 14px; border-radius:8px; border:1px solid var(--border); background:transparent; color:var(--fg); cursor:pointer; }
  button.primary { background:var(--accent); color:var(--bg); border-color:var(--accent); }
</style></head><body><main>${body}</main></body></html>`,
    { status, headers },
  );
}

function consentPage(details: ConsentDescription, handle: string, env: WorkerEnv): string {
  const name = escape(details.clientName);
  const origin = details.clientDomain
    ? `Published by <strong>${escape(details.clientDomain)}</strong>.`
    : "This app registered itself; its name is not verified.";
  const wantsWrite = details.scope.includes("db:write");
  const login = loginMode(env);
  return `<h1>Allow ${name} to use db-mcp?</h1>
<p>${origin} Access will be sent to <strong>${escape(details.redirectHost)}</strong>.</p>
${details.redirectIsLoopback ? '<p class="warn">This sends access to an app on your computer. Continue only if you just started signing in from it.</p>' : ""}
<form method="post">
  <input type="hidden" name="handle" value="${escape(handle)}">
  <fieldset>
    <label><input type="checkbox" checked disabled> <span>Read data<small>schemas, tables, read-only SQL</small></span></label>
    <input type="hidden" name="scope" value="db:read">
    <label><input type="checkbox" name="scope" value="db:write"${wantsWrite ? " checked" : ""}> <span>Write data<small>sql_execute, up to each connection's access level</small></span></label>
  </fieldset>
  ${login === "password" ? '<input type="password" name="password" placeholder="Access password" autocomplete="current-password" required autofocus>' : ""}
  <div class="row">
    <button name="decision" value="deny">Deny</button>
    <button class="primary" name="decision" value="approve">${login === "github" ? "Continue with GitHub" : "Allow"}</button>
  </div>
</form>`;
}

function loginMode(env: WorkerEnv): "github" | "password" {
  const mode = (env.OAUTH_LOGIN ?? (env.GITHUB_CLIENT_ID ? "github" : "password")).trim().toLowerCase();
  if (mode === "github") {
    if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET || !env.OAUTH_ALLOWED_USERS?.trim()) {
      throw new Error(
        "OAUTH_LOGIN=github needs GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET and OAUTH_ALLOWED_USERS",
      );
    }
    return "github";
  }
  if (mode === "password") {
    if (!env.OAUTH_PASSWORD || env.OAUTH_PASSWORD.length < 16) {
      throw new Error("OAUTH_LOGIN=password needs OAUTH_PASSWORD (at least 16 characters)");
    }
    return "password";
  }
  throw new Error(`OAUTH_LOGIN must be github or password, got: ${mode}`);
}

async function safeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const ax = new Uint8Array(x);
  const by = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < ax.length; i++) diff |= ax[i]! ^ by[i]!;
  return diff === 0;
}

function base64Url(bytes: ArrayBuffer): string {
  let bin = "";
  for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function allowedGithubUsers(env: WorkerEnv): Set<string> {
  return new Set(
    (env.OAUTH_ALLOWED_USERS ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

async function authorizeApp(request: Request, env: WorkerEnv): Promise<Response> {
  const url = new URL(request.url);
  const oauth = env.OAUTH_PROVIDER!;
  try {
    if (url.pathname === "/authorize" && request.method === "GET") {
      const authRequest = await oauth.parseAuthRequest(request);
      const details = await oauth.describeConsent(authRequest);
      const consent = await oauth.beginConsent(authRequest);
      return page(
        `Authorize ${details.clientName}`,
        consentPage(details, consent.handle, env),
        consent.headers,
      );
    }

    if (url.pathname === "/authorize" && request.method === "POST") {
      const form = await request.formData();
      const handle = String(form.get("handle") ?? "");
      if (form.get("decision") !== "approve") {
        const denied = await oauth.denyConsent(request, handle);
        denied.headers.set("Location", denied.redirectTo);
        return new Response(null, { status: 302, headers: denied.headers });
      }
      const login = loginMode(env);
      if (
        login === "password" &&
        !(await safeEqual(String(form.get("password") ?? ""), env.OAUTH_PASSWORD!))
      ) {
        // The handle is not consumed yet: going back retries the same page.
        return page(
          "Wrong password",
          "<h1>Wrong password</h1><p>Go back and try again.</p>",
          new Headers(),
          401,
        );
      }
      const scope = [
        "db:read",
        ...(form.getAll("scope").map(String).includes("db:write") ? ["db:write"] : []),
      ];
      const approved = await oauth.approveConsent(request, handle, { scope });

      if (login === "password") {
        const { redirectTo } = await oauth.completeAuthorization({
          request: approved.request,
          userId: "password",
          metadata: { provider: "password" },
          scope: approved.request.scope,
          props: { principal: "password", provider: "password" } satisfies AuthProps,
        });
        approved.headers.set("Location", redirectTo);
        return new Response(null, { status: 302, headers: approved.headers });
      }

      // GitHub: PKCE verifier kept server-side by beginUpstream, state bound to this browser.
      const verifier = `${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/g, "");
      const challenge = base64Url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
      const { state, headers } = await oauth.beginUpstream(approved.request, {
        data: { verifier },
        headers: approved.headers,
      });
      const gh = new URL("https://github.com/login/oauth/authorize");
      gh.searchParams.set("client_id", env.GITHUB_CLIENT_ID!);
      gh.searchParams.set("redirect_uri", `${url.origin}/oauth/github/callback`);
      gh.searchParams.set("scope", "read:user");
      gh.searchParams.set("state", state);
      gh.searchParams.set("code_challenge", challenge);
      gh.searchParams.set("code_challenge_method", "S256");
      gh.searchParams.set("allow_signup", "false");
      headers.set("Location", gh.toString());
      return new Response(null, { status: 302, headers });
    }

    if (url.pathname === "/oauth/github/callback" && request.method === "GET") {
      const { request: original, data, headers } = await oauth.finishUpstream<{ verifier: string }>(request);
      const deny = (description: string) => {
        headers.set("Location", authorizationErrorRedirect(original, "access_denied", description));
        return new Response(null, { status: 302, headers });
      };
      const code = url.searchParams.get("code");
      if (url.searchParams.get("error") || !code) return deny("GitHub sign-in was cancelled");

      const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({
          client_id: env.GITHUB_CLIENT_ID,
          client_secret: env.GITHUB_CLIENT_SECRET,
          code,
          redirect_uri: `${url.origin}/oauth/github/callback`,
          code_verifier: data.verifier,
        }),
      });
      const token = (await tokenRes.json().catch(() => ({}))) as { access_token?: string; error?: string };
      if (!token.access_token) return deny(`GitHub token exchange failed: ${token.error ?? tokenRes.status}`);

      const userRes = await fetch("https://api.github.com/user", {
        headers: {
          authorization: `Bearer ${token.access_token}`,
          accept: "application/vnd.github+json",
          "user-agent": "db-mcp",
        },
      });
      const user = (await userRes.json().catch(() => ({}))) as { login?: string };
      const login = user.login?.toLowerCase();
      if (!login || !allowedGithubUsers(env).has(login)) {
        return deny(`GitHub user ${user.login ?? "?"} is not allowed on this server`);
      }
      const { redirectTo } = await oauth.completeAuthorization({
        request: original,
        userId: `github:${login}`,
        metadata: { provider: "github" },
        scope: original.scope,
        props: { principal: `github:${login}`, provider: "github" } satisfies AuthProps,
      });
      headers.set("Location", redirectTo);
      return new Response(null, { status: 302, headers });
    }
  } catch (error) {
    if (error instanceof AuthorizationError && error.redirectTo) {
      return Response.redirect(error.redirectTo, 302);
    }
    if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
      const message =
        error instanceof AuthorizationError ? error.description : "This app could not be verified.";
      return page(
        "Authorization failed",
        `<h1>Authorization failed</h1><p>${escape(message)}</p>`,
        new Headers(),
        400,
      );
    }
    throw error;
  }

  return new Response(JSON.stringify({ error: "not_found" }), {
    status: 404,
    headers: { "content-type": "application/json" },
  });
}

export type { OAuthHelpers };
