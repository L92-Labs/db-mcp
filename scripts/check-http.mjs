#!/usr/bin/env node
// Asserting MCP check for a read-only server with the isolated Postgres/MySQL fixtures.
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const base = new URL(process.argv[2] ?? 'http://127.0.0.1:8787');
const token = process.env.MCP_BEARER_TOKEN;
assert.ok(token, 'MCP_BEARER_TOKEN is required');
assert.equal((await fetch(new URL('/health', base))).status, 200);
assert.equal((await fetch(new URL('/mcp', base), { method: 'POST', body: '{}' })).status, 401);
const client = new Client({ name: 'db-mcp-ci', version: '1' });
try {
  await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', base), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }));
  const tools = (await client.listTools()).tools.map(t => t.name);
  assert.ok(tools.includes('sql_query'));
  assert.ok(!tools.includes('sql_execute'), 'Read-only mode must not advertise writes');
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError, `${name} failed: ${JSON.stringify(result.content)}`);
    return JSON.parse(result.content[0].text);
  };
  const connections = await call('connections_list');
  assert.equal(connections.connections.length, 2);
  for (const connection of ['postgres', 'mysql']) {
    const args = { connection };
    const info = await call('connection_info', args);
    assert.equal(info.engine, connection);
    const result = await call('sql_query', { ...args, sql: 'SELECT 1 AS one' });
    assert.equal(Number(result.rows[0].one), 1);
    const denied = await client.callTool({ name: 'sql_query', arguments: { ...args, sql: 'DELETE FROM shop.orders WHERE 1=0' } });
    assert.equal(denied.isError, true, `${connection} must reject writes through sql_query`);
    assert.match(denied.content[0].text, /read-only|only runs reads/i, 'Refusal must come from access policy');
    console.log(`PASS ${connection}: authenticated query + write refusal`);
  }
  console.log('PASS HTTP health, bearer auth and read-only MCP tool surface');
} finally {
  await client.close();
}
