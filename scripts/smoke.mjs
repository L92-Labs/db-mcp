#!/usr/bin/env node
// End-to-end check of a running db-mcp over Streamable HTTP.
// Usage: node scripts/smoke.mjs http://localhost:8787/mcp <bearer-token>
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const [url = "http://localhost:8787/mcp", token = process.env.MCP_BEARER_TOKEN] = process.argv.slice(2);
const client = new Client({ name: "db-mcp-smoke", version: "0" });
await client.connect(
  new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  }),
);

const call = async (name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content?.[0]?.text ?? "";
  return { isError: Boolean(res.isError), body: res.isError ? text : JSON.parse(text) };
};

const { tools } = await client.listTools();
console.log("tools:", tools.map((t) => t.name).join(", "));
const conns = await call("connections_list");
console.log("connections:", JSON.stringify(conns.body.connections));
const info = await call("connection_info");
console.log(
  "connection_info:",
  info.isError
    ? `ERROR ${info.body}`
    : `${info.body.engine} ${info.body.server_version ?? info.body.project_id}`,
);
const tables = await call("tables_list", { limit: 20 });
console.log(
  "tables:",
  tables.isError ? `ERROR ${tables.body}` : tables.body.tables.map((t) => `${t.schema}.${t.name}`).join(", "),
);
const q = await call("sql_query", { sql: "SELECT 1 AS one" });
console.log("sql_query:", q.isError ? `ERROR ${q.body}` : JSON.stringify(q.body.rows));
const w = await call("sql_query", { sql: "DELETE FROM nothing" });
console.log("sql_query DELETE refused:", w.isError, w.body.slice?.(0, 120));
await client.close();
