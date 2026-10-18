#!/usr/bin/env node
// End-to-end OAuth check against a Worker running AUTH_MODE=oauth + OAUTH_LOGIN=password.
// Walks discovery → dynamic registration → consent (password) → token → MCP call, like an MCP client.
// Usage: node scripts/oauth-smoke.mjs http://localhost:8787 <OAUTH_PASSWORD> [read|write]
import { createHash, randomBytes } from "node:crypto";

const [base = "http://localhost:8787", password, want = "read"] = process.argv.slice(2);
const b64url = (buf) => Buffer.from(buf).toString("base64url");
const step = (name, ok, detail = "") =>
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);

const unauth = await fetch(`${base}/mcp`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: "{}",
});
const challenge = unauth.headers.get("www-authenticate") ?? "";
step(
  "401 challenge",
  unauth.status === 401 && challenge.includes("resource_metadata"),
  challenge.slice(0, 120),
);

const prm = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
const asm = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
step("discovery", Boolean(prm.resource && asm.token_endpoint), `resource=${prm.resource}`);

const redirectUri = "http://127.0.0.1:53682/callback";
const reg = await (
  await fetch(asm.registration_endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "db-mcp smoke",
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
    }),
  })
).json();
step("dynamic registration", Boolean(reg.client_id));

const verifier = b64url(randomBytes(32));
const scope = want === "write" ? "db:read db:write" : "db:read";
const auth = new URL(asm.authorization_endpoint);
for (const [k, v] of Object.entries({
  response_type: "code",
  client_id: reg.client_id,
  redirect_uri: redirectUri,
  scope,
  state: "s1",
  code_challenge: b64url(createHash("sha256").update(verifier).digest()),
  code_challenge_method: "S256",
  resource: prm.resource,
}))
  auth.searchParams.set(k, v);
const consent = await fetch(auth, { redirect: "manual" });
const html = await consent.text();
const cookies = consent.headers
  .getSetCookie()
  .map((c) => c.split(";")[0])
  .join("; ");
const handle = /name="handle" value="([^"]+)"/.exec(html)?.[1];
step("consent page", consent.status === 200 && Boolean(handle) && html.includes("db-mcp smoke"));

const post = (pw) =>
  fetch(asm.authorization_endpoint, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookies },
    body: new URLSearchParams([
      ["handle", handle],
      ["scope", "db:read"],
      ...(want === "write" ? [["scope", "db:write"]] : []),
      ["password", pw],
      ["decision", "approve"],
    ]),
  });
const wrong = await post("definitely-not-the-password");
step("wrong password refused", wrong.status === 401);
const approved = await post(password);
const location = approved.headers.get("location") ?? "";
const code = new URL(location, base).searchParams.get("code");
step("approve → redirect with code", approved.status === 302 && Boolean(code), location.slice(0, 80));

const token = await (
  await fetch(asm.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: reg.client_id,
      code_verifier: verifier,
      resource: prm.resource,
    }),
  })
).json();
step("token exchange", Boolean(token.access_token), `scope=${token.scope}`);

const rpc = async (method, params = {}) => {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token.access_token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return res.json();
};
await rpc("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "smoke", version: "0" },
});
const tools = (await rpc("tools/list")).result.tools.map((t) => t.name);
step("tools/list with OAuth token", tools.length > 0, tools.join(","));
step(
  want === "write" ? "db:write → sql_execute present" : "db:read only → sql_execute hidden",
  tools.includes("sql_execute") === (want === "write"),
);
const q = await rpc("tools/call", { name: "sql_query", arguments: { sql: "SELECT 1 AS one" } });
step("sql_query", !q.result?.isError, q.result?.content?.[0]?.text?.slice(0, 80));
