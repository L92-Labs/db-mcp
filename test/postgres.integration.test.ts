/**
 * Real-Postgres tests. Run with:
 *   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres pnpm test
 * against a database seeded with examples/seed.sql. Skipped when unset.
 */
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import {
  createDispatchContext,
  createPostgresAdapter,
  dispatchTool,
  loadRuntimeConfig,
  pgClientConfig,
  type PostgresConnection,
} from "@db-mcp/core";

const url = process.env.TEST_DATABASE_URL;
const pools: pg.Pool[] = [];

function ctxFor(access: string) {
  const config = loadRuntimeConfig({ DATABASE_URL: url!, DB_ACCESS: access, DB_MAX_ROWS: "100" });
  return createDispatchContext(config, (connection) => {
    const c = connection as PostgresConnection;
    const pool = new pg.Pool({ ...pgClientConfig(c, c.url!), max: 2 });
    pools.push(pool);
    return createPostgresAdapter(c, {
      async connect() {
        const client = await pool.connect();
        return { client, release: (e) => client.release(e) };
      },
    });
  });
}

afterAll(async () => {
  await Promise.all(pools.map((p) => p.end()));
});

describe.skipIf(!url)("postgres adapter (live)", () => {
  const ro = ctxFor("read_only");
  const rw = ctxFor("read_write");
  const admin = ctxFor("admin");

  it("connection_info", async () => {
    const info = (await dispatchTool("connection_info", {}, ro)) as Record<string, unknown>;
    expect(info.server_version).toMatch(/^\d+/);
    expect(info.database).toBe("postgres");
  });

  it("explores schemas, tables, columns", async () => {
    const schemas = (await dispatchTool("schemas_list", {}, ro)) as { schemas: Array<{ name: string }> };
    expect(schemas.schemas.map((s) => s.name)).toEqual(expect.arrayContaining(["public", "shop"]));

    const tables = (await dispatchTool("tables_list", { schema: "shop" }, ro)) as {
      tables: Array<{ name: string; kind: string }>;
    };
    expect(tables.tables).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "orders", kind: "table" }),
        expect.objectContaining({ name: "order_totals", kind: "view" }),
      ]),
    );
    const filtered = (await dispatchTool("tables_list", { pattern: "cust" }, ro)) as { tables: unknown[] };
    expect(filtered.tables).toHaveLength(1);

    const cols = (await dispatchTool("columns_search", { pattern: "customer" }, ro)) as {
      columns: Array<{ table: string; column: string }>;
    };
    expect(cols.columns).toEqual([expect.objectContaining({ table: "orders", column: "customer_id" })]);
  });

  it("describes a table with keys and indexes", async () => {
    const d = (await dispatchTool("table_describe", { table: "shop.orders" }, ro)) as Record<string, any>;
    expect(d.primary_key).toBe("PRIMARY KEY (id)");
    expect(d.columns.map((c: { name: string }) => c.name)).toEqual([
      "id",
      "customer_id",
      "total_cents",
      "status",
      "placed_on",
      "meta",
    ]);
    expect(d.constraints.some((c: { type: string }) => c.type === "foreign_key")).toBe(true);
    expect(d.indexes.map((i: { name: string }) => i.name)).toContain("orders_customer_idx");
    const v = (await dispatchTool("table_describe", { schema: "shop", table: "order_totals" }, ro)) as Record<
      string,
      any
    >;
    expect(v.kind).toBe("view");
    expect(v.view_definition).toMatch(/SELECT/i);
    const c = (await dispatchTool("table_describe", { schema: "shop", table: "customers" }, ro)) as Record<
      string,
      any
    >;
    expect(c.referenced_by[0].table).toBe("shop.orders");
  });

  it("queries with params, types, truncation", async () => {
    const r = (await dispatchTool(
      "sql_query",
      {
        sql: "SELECT id, email, created_at FROM shop.customers WHERE email = $1",
        params: ["ada@example.com"],
      },
      ro,
    )) as Record<string, any>;
    expect(r.rows).toEqual([{ id: "1", email: "ada@example.com", created_at: "2024-01-02 03:04:05+00" }]);
    expect(r.columns).toEqual([
      { name: "id", type: "bigint" },
      { name: "email", type: "text" },
      { name: "created_at", type: "timestamp with time zone" },
    ]);
    const t = (await dispatchTool(
      "sql_query",
      { sql: "SELECT g FROM generate_series(1, 1000) g", max_rows: 5 },
      ro,
    )) as Record<string, any>;
    expect(t).toMatchObject({ row_count: 5, truncated: true });
    const s = (await dispatchTool("table_sample", { table: "shop.orders", limit: 2 }, ro)) as Record<
      string,
      any
    >;
    expect(s.row_count).toBe(2);
  });

  it("READ ONLY transaction blocks writes the classifier cannot see", async () => {
    // A data-modifying function call looks like a plain SELECT to the lexer.
    await dispatchTool(
      "sql_execute",
      {
        sql: "CREATE OR REPLACE FUNCTION public.sneaky() RETURNS int LANGUAGE sql AS $$ INSERT INTO shop.customers(email) VALUES ('x@y.z') RETURNING 1 $$",
      },
      admin,
    );
    await expect(dispatchTool("sql_query", { sql: "SELECT public.sneaky()" }, ro)).rejects.toThrow(
      /read-only transaction/,
    );
    await dispatchTool("sql_execute", { sql: "DROP FUNCTION public.sneaky()" }, admin);
  });

  it("server rejects stacked statements smuggled past the lexer", async () => {
    const adapter = ro.adapterFor(ro.config.connections.postgres!);
    await expect(
      adapter.run({
        sql: "SELECT 1; DELETE FROM shop.orders",
        maxRows: 10,
        timeoutMs: 5000,
        allow: "read",
        classified: "read",
      }),
    ).rejects.toThrow(/multiple commands|prepared statement/);
  });

  it("read_write runs DML in a transaction, refuses DDL", async () => {
    const ins = (await dispatchTool(
      "sql_execute",
      {
        sql: "INSERT INTO shop.customers (email, name) VALUES ($1, $2) RETURNING id, email",
        params: ["grace@example.com", "Grace"],
      },
      rw,
    )) as Record<string, any>;
    expect(ins).toMatchObject({ command: "INSERT", affected_rows: 1, statement_class: "write" });
    expect(ins.rows[0].email).toBe("grace@example.com");
    const del = (await dispatchTool(
      "sql_execute",
      { sql: "DELETE FROM shop.customers WHERE email = 'grace@example.com'" },
      rw,
    )) as Record<string, any>;
    expect(del.affected_rows).toBe(1);
    await expect(dispatchTool("sql_execute", { sql: "DROP TABLE shop.orders" }, rw)).rejects.toThrow(/admin/);
    await expect(dispatchTool("sql_query", { sql: "DELETE FROM shop.orders" }, rw)).rejects.toThrow(
      /read-only/,
    );
  });

  it("statement timeout applies", async () => {
    const config = loadRuntimeConfig({ DATABASE_URL: url!, DB_STATEMENT_TIMEOUT_MS: "200" });
    const quick = createDispatchContext(config, (connection) => ro.adapterFor(connection));
    await expect(dispatchTool("sql_query", { sql: "SELECT pg_sleep(2)" }, quick)).rejects.toThrow(
      /statement timeout/,
    );
  });

  it("admin runs scripts and explain returns a plan", async () => {
    const r = (await dispatchTool(
      "sql_execute",
      {
        sql: "CREATE TEMP TABLE tmp_x (a int); INSERT INTO tmp_x VALUES (1), (2); SELECT count(*) AS n FROM tmp_x",
      },
      admin,
    )) as Record<string, any>;
    expect(r).toMatchObject({ statements: 3, rows: [{ n: "2" }] });
    const e = (await dispatchTool(
      "sql_explain",
      { sql: "SELECT * FROM shop.orders WHERE id = $1", params: [1] },
      ro,
    )) as Record<string, any>;
    expect(e.plan.Plan["Node Type"]).toBeDefined();
  });
});
