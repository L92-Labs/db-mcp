import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  authorizeBearer,
  buildMcpServer,
  createDispatchContext,
  dispatchTool,
  enabledTools,
  loadRuntimeConfig,
  type DbAdapter,
  type QueryResult,
  type RunInput,
} from "@db-mcp/core";

function fakeAdapter(): DbAdapter & { run: ReturnType<typeof vi.fn> } {
  const result: QueryResult = {
    columns: [],
    rows: [],
    row_count: 0,
    truncated: false,
    statement_class: "read",
  };
  return {
    engine: "postgres",
    info: vi.fn(async () => ({ server_version: "17" })),
    listSchemas: vi.fn(async () => [{ name: "public" }]),
    listTables: vi.fn(async () => [{ schema: "public", name: "users" }]),
    describeTable: vi.fn(async (ref) => ({ ...ref, columns: [] })),
    sampleTable: vi.fn(async () => result),
    searchColumns: vi.fn(async () => []),
    run: vi.fn(async (input: RunInput) => ({ ...result, statement_class: input.classified })),
    explain: vi.fn(async () => ({ plan: {} })),
  };
}

function ctxFor(env: Record<string, string>) {
  const adapter = fakeAdapter();
  const ctx = createDispatchContext(loadRuntimeConfig(env), () => adapter);
  return { ctx, adapter };
}

const RO = { DATABASE_URL: "postgres://x", DB_MAX_ROWS: "50" };
const RW = { ...RO, DB_ACCESS: "read_write" };

describe("enabledTools", () => {
  it("hides sql_execute when every connection is read_only", () => {
    expect(enabledTools(loadRuntimeConfig(RO))).not.toContain("sql_execute");
    expect(enabledTools(loadRuntimeConfig(RW))).toContain("sql_execute");
  });
});

describe("dispatchTool", () => {
  it("lists connections with access", async () => {
    const { ctx } = ctxFor(RW);
    const out = (await dispatchTool("connections_list", {}, ctx)) as {
      connections: Array<{ access: string }>;
    };
    expect(out.connections[0]!.access).toBe("read_write");
  });

  it("sql_query is read-only even on writable connections", async () => {
    const { ctx, adapter } = ctxFor(RW);
    await expect(dispatchTool("sql_query", { sql: "DELETE FROM users" }, ctx)).rejects.toThrow(/sql_execute/);
    await dispatchTool("sql_query", { sql: "SELECT 1", max_rows: 500 }, ctx);
    expect(adapter.run).toHaveBeenCalledWith(expect.objectContaining({ allow: "read", maxRows: 50 }));
  });

  it("sql_execute is gated by connection access", async () => {
    const { ctx, adapter } = ctxFor(RW);
    await dispatchTool("sql_execute", { sql: "UPDATE users SET a = 1" }, ctx);
    expect(adapter.run).toHaveBeenLastCalledWith(
      expect.objectContaining({ allow: "write", classified: "write" }),
    );
    await expect(dispatchTool("sql_execute", { sql: "DROP TABLE users" }, ctx)).rejects.toThrow(/admin/);
    const ro = ctxFor(RO);
    await expect(dispatchTool("sql_execute", { sql: "SELECT 1" }, ro.ctx)).rejects.toThrow(/disabled/);
  });

  it("sql_explain refuses EXPLAIN input and scripts", async () => {
    const { ctx } = ctxFor(RO);
    await expect(dispatchTool("sql_explain", { sql: "EXPLAIN ANALYZE DELETE FROM t" }, ctx)).rejects.toThrow(
      /adds EXPLAIN/,
    );
    await expect(dispatchTool("sql_explain", { sql: "SELECT 1; SELECT 2" }, ctx)).rejects.toThrow(
      /one statement/,
    );
    await expect(dispatchTool("sql_explain", { sql: "DELETE FROM t" }, ctx)).resolves.toMatchObject({
      statement_class: "write",
    });
  });

  it("splits schema.table refs", async () => {
    const { ctx, adapter } = ctxFor(RO);
    await dispatchTool("table_describe", { table: "sales.orders" }, ctx);
    expect(adapter.describeTable).toHaveBeenCalledWith({ schema: "sales", table: "orders" });
  });

  it("rejects unknown connections and args", async () => {
    const { ctx } = ctxFor(RO);
    await expect(dispatchTool("schemas_list", { connection: "nope" }, ctx)).rejects.toThrow(
      /unknown connection/,
    );
    await expect(dispatchTool("sql_query", { query: "SELECT 1" }, ctx)).rejects.toThrow();
  });
});

describe("MCP server", () => {
  async function connect(env: Record<string, string>) {
    const { ctx } = ctxFor(env);
    const server = buildMcpServer(ctx);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
    return client;
  }

  it("exposes typed tools with annotations and instructions", async () => {
    const client = await connect(RW);
    const { tools } = await client.listTools();
    const query = tools.find((t) => t.name === "sql_query")!;
    expect(query.annotations?.readOnlyHint).toBe(true);
    expect(query.inputSchema.required).toContain("sql");
    expect(tools.find((t) => t.name === "sql_execute")!.annotations?.destructiveHint).toBe(true);
    expect(client.getInstructions()).toMatch(/postgres \(default\): postgres, read_write/);
  });

  it("returns tool errors as isError results", async () => {
    const client = await connect(RO);
    const res = await client.callTool({ name: "sql_query", arguments: { sql: "DROP TABLE x" } });
    expect(res.isError).toBe(true);
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).not.toContain("sql_execute");
  });
});

describe("authorizeBearer", () => {
  it("accepts matching bearer only", () => {
    expect(authorizeBearer("secret", "Bearer secret")).toBe(true);
    expect(authorizeBearer("secret", "Bearer nope")).toBe(false);
    expect(authorizeBearer(undefined, "Bearer x")).toBe(false);
  });
});
