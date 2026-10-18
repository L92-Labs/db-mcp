/**
 * Real-MySQL tests. Run with:
 *   TEST_MYSQL_URL=mysql://root:root@localhost:3306/shop pnpm test
 * against a server seeded with examples/seed.mysql.sql. Skipped when unset.
 */
import mysql from "mysql2/promise";
import { afterAll, describe, expect, it } from "vitest";
import {
  createDispatchContext,
  createMySqlAdapter,
  dispatchTool,
  loadRuntimeConfig,
  mysqlClientOptions,
  type MySqlConnection,
} from "@db-mcp/core";

const url = process.env.TEST_MYSQL_URL;
const pools: mysql.Pool[] = [];

function ctxFor(access: string, extra: Record<string, string> = {}) {
  const config = loadRuntimeConfig({ MYSQL_URL: url!, DB_ACCESS: access, DB_MAX_ROWS: "100", ...extra });
  return createDispatchContext(config, (connection) => {
    const c = connection as MySqlConnection;
    const pool = mysql.createPool({ ...mysqlClientOptions(c, { uri: c.url! }), connectionLimit: 2 });
    pools.push(pool);
    return createMySqlAdapter(c, {
      async connect() {
        const conn = await pool.getConnection();
        return { client: conn, release: (e) => (e ? conn.destroy() : conn.release()) };
      },
    });
  });
}

afterAll(async () => {
  await Promise.all(pools.map((p) => p.end()));
});

describe.skipIf(!url)("mysql adapter (live)", () => {
  const ro = url ? ctxFor("read_only") : (undefined as never);
  const rw = url ? ctxFor("read_write") : (undefined as never);
  const admin = url ? ctxFor("admin") : (undefined as never);
  const guarded = url
    ? ctxFor("read_write", { MYSQL_SCHEMAS: "shop", MYSQL_HIDDEN_COLUMNS: "api_token" })
    : (undefined as never);

  it("connection_info + exploration", async () => {
    const info = (await dispatchTool("connection_info", {}, ro)) as any;
    expect(info.version).toMatch(/^8\./);
    expect(info.database).toBe("shop");
    const schemas = (await dispatchTool("schemas_list", {}, ro)) as any;
    expect(schemas.schemas.map((s: any) => s.name)).toEqual(expect.arrayContaining(["shop", "secret"]));
    const tables = (await dispatchTool("tables_list", { schema: "shop" }, ro)) as any;
    expect(tables.tables.map((t: any) => `${t.name}:${t.kind}`)).toEqual([
      "customers:table",
      "order_totals:view",
      "orders:table",
    ]);
    const cols = (await dispatchTool("columns_search", { pattern: "customer" }, ro)) as any;
    expect(cols.columns).toEqual([expect.objectContaining({ table: "orders", column: "customer_id" })]);
  });

  it("describes keys, indexes, references, views", async () => {
    const d = (await dispatchTool("table_describe", { table: "orders" }, ro)) as any;
    expect(d.primary_key).toBe("PRIMARY KEY (id)");
    expect(d.constraints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "foreign_key", references: "shop.customers" }),
      ]),
    );
    expect(d.indexes.map((i: any) => i.name)).toEqual(
      expect.arrayContaining(["PRIMARY", "orders_customer_idx"]),
    );
    const c = (await dispatchTool("table_describe", { table: "shop.customers" }, ro)) as any;
    expect(c.referenced_by[0].table).toBe("shop.orders");
    const v = (await dispatchTool("table_describe", { table: "order_totals" }, ro)) as any;
    expect(v.kind).toBe("view");
    expect(v.view_definition).toMatch(/select/i);
  });

  it("queries with params, types, row cap via sql_select_limit", async () => {
    const r = (await dispatchTool(
      "sql_query",
      {
        sql: "SELECT c.id, email, created_at, meta FROM customers c JOIN orders o ON o.customer_id = c.id WHERE email = ? ORDER BY o.id",
        params: ["ada@example.com"],
      },
      ro,
    )) as any;
    expect(r.rows[0]).toEqual({
      id: "1",
      email: "ada@example.com",
      created_at: "2024-01-02 03:04:05",
      meta: { coupon: "WELCOME" },
    });
    expect(r.columns.map((c: any) => c.type)).toEqual(["longlong", "var_string", "datetime", "json"]);
    const big = (await dispatchTool(
      "sql_query",
      {
        sql: "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 900) SELECT i FROM n ORDER BY i DESC",
        max_rows: 3,
      },
      ro,
    )) as any;
    expect(big).toMatchObject({
      row_count: 3,
      truncated: true,
      rows: [{ i: "900" }, { i: "899" }, { i: "898" }],
    });
    const sample = (await dispatchTool("table_sample", { table: "orders", limit: 2 }, ro)) as any;
    expect(sample.row_count).toBe(2);
  });

  it("read-only is enforced by the server too", async () => {
    await expect(dispatchTool("sql_query", { sql: "DELETE FROM orders" }, ro)).rejects.toThrow(
      /not read-only/,
    );
    const adapter = ro.adapterFor(ro.config.connections.mysql!);
    await expect(
      adapter.run({
        sql: "UPDATE orders SET status = 'x'",
        maxRows: 10,
        timeoutMs: 5000,
        allow: "read",
        classified: "read",
      }),
    ).rejects.toThrow(/READ ONLY transaction/);
    await expect(
      adapter.run({
        sql: "SELECT 1; DELETE FROM orders",
        maxRows: 10,
        timeoutMs: 5000,
        allow: "read",
        classified: "read",
      }),
    ).rejects.toThrow(/syntax/);
  });

  it("read_write DML, dry_run, DDL refused", async () => {
    await dispatchTool("sql_execute", { sql: "DELETE FROM customers WHERE email = 'grace@example.com'" }, rw);
    const ins = (await dispatchTool(
      "sql_execute",
      { sql: "INSERT INTO customers (email, name) VALUES (?, ?)", params: ["grace@example.com", "Grace"] },
      rw,
    )) as any;
    expect(ins).toMatchObject({ affected_rows: 1, statement_class: "write" });
    expect(Number(ins.insert_id)).toBeGreaterThan(2);
    const dry = (await dispatchTool(
      "sql_execute",
      { sql: "DELETE FROM customers WHERE email = ?", params: ["grace@example.com"], dry_run: true },
      rw,
    )) as any;
    expect(dry).toMatchObject({ dry_run: true, rolled_back: true, affected_rows: 1 });
    const still = (await dispatchTool(
      "sql_query",
      { sql: "SELECT COUNT(*) AS n FROM customers WHERE email = 'grace@example.com'" },
      ro,
    )) as any;
    expect(still.rows[0].n).toBe("1"); // COUNT(*) is BIGINT → string (bigNumberStrings)
    const del = (await dispatchTool(
      "sql_execute",
      { sql: "DELETE FROM customers WHERE email = 'grace@example.com'" },
      rw,
    )) as any;
    expect(del.affected_rows).toBe(1);
    await expect(dispatchTool("sql_execute", { sql: "DROP TABLE orders" }, rw)).rejects.toThrow(/admin/);
    await expect(
      dispatchTool("sql_execute", { sql: "CREATE TABLE tmp_x (a INT)", dry_run: true }, admin),
    ).rejects.toThrow(/implicitly/);
    await dispatchTool("sql_execute", { sql: "CREATE TABLE tmp_x (a INT)" }, admin);
    await dispatchTool("sql_execute", { sql: "DROP TABLE tmp_x" }, admin);
  });

  it("policy: allowlist + hidden columns", async () => {
    const schemas = (await dispatchTool("schemas_list", {}, guarded)) as any;
    expect(schemas.schemas.map((s: any) => s.name)).toEqual(["shop"]);
    await expect(dispatchTool("sql_query", { sql: "SELECT * FROM secret.vault" }, guarded)).rejects.toThrow(
      /allowlist/,
    );
    await expect(
      dispatchTool("sql_query", { sql: "SELECT * FROM `secret`.`vault`" }, guarded),
    ).rejects.toThrow(/allowlist/);
    await expect(dispatchTool("sql_execute", { sql: "DELETE FROM secret.vault" }, guarded)).rejects.toThrow(
      /allowlist/,
    );
    await expect(dispatchTool("sql_query", { sql: "SELECT * FROM customers" }, guarded)).rejects.toThrow(
      /hidden/,
    );
    await expect(dispatchTool("sql_query", { sql: "SELECT c.* FROM customers c" }, guarded)).rejects.toThrow(
      /hidden/,
    );
    const ok = (await dispatchTool("sql_query", { sql: "SELECT email AS e FROM customers" }, guarded)) as any;
    expect(ok.row_count).toBe(2);
    const s = (await dispatchTool("table_sample", { table: "customers" }, guarded)) as any;
    expect(s.columns.map((c: any) => c.name)).toEqual(["id", "email", "name", "created_at"]);
    const d = (await dispatchTool("table_describe", { table: "customers" }, guarded)) as any;
    expect(d.hidden_columns).toBe(1);
  });

  it("explain returns a JSON plan", async () => {
    const e = (await dispatchTool(
      "sql_explain",
      { sql: "SELECT * FROM orders WHERE id = ?", params: [1] },
      ro,
    )) as any;
    expect(e.plan.query_block).toBeDefined();
  });
});
