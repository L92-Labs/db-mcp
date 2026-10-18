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

describe.skipIf(!url)("mysql review fixes (live)", () => {
  const ro = url ? ctxFor("read_only") : (undefined as never);
  const guarded = url
    ? ctxFor("read_write", { MYSQL_SCHEMAS: "shop", MYSQL_HIDDEN_COLUMNS: "api_token" })
    : (undefined as never);

  it("an explicit huge LIMIT is still capped client-side and the pool recovers", async () => {
    const started = Date.now();
    const r = (await dispatchTool(
      "sql_query",
      {
        sql: "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 900) SELECT a.i, b.i AS j FROM n a CROSS JOIN n b LIMIT 100000000",
        max_rows: 5,
      },
      ro,
    )) as any;
    expect(r).toMatchObject({ row_count: 5, truncated: true });
    expect(Date.now() - started).toBeLessThan(5_000);
    const again = (await dispatchTool("sql_query", { sql: "SELECT 1 AS one" }, ro)) as any;
    expect(again.rows).toEqual([{ one: "1" }]); // integer literals are BIGINT → string
  });

  it("ANSI_QUOTES on the server cannot smuggle a qualified name past the allowlist", async () => {
    const root = await mysql.createConnection(url!);
    const [[{ mode }]] = (await root.query("SELECT @@GLOBAL.sql_mode AS mode")) as any;
    await root.query("SET GLOBAL sql_mode = CONCAT(@@GLOBAL.sql_mode, ',ANSI_QUOTES')");
    try {
      const fresh = ctxFor("read_write", { MYSQL_SCHEMAS: "shop" });
      await expect(
        dispatchTool("sql_execute", { sql: 'DELETE FROM "secret"."vault"' }, fresh),
      ).rejects.toThrow();
      const [[{ n }]] = (await root.query("SELECT COUNT(*) AS n FROM secret.vault")) as any;
      expect(Number(n)).toBe(1);
    } finally {
      await root.query("SET GLOBAL sql_mode = ?", [mode]);
      await root.end();
    }
  });

  it("positional writes into a table with hidden columns are refused", async () => {
    await expect(
      dispatchTool(
        "sql_execute",
        { sql: "INSERT INTO customers VALUES (99, 'x@y.z', 'X', 'tok', NOW())" },
        guarded,
      ),
    ).rejects.toThrow(/list the columns/);
    await expect(
      dispatchTool(
        "sql_execute",
        {
          sql: "INSERT INTO orders (customer_id, total_cents, placed_on) SELECT * FROM customers",
          dry_run: true,
        },
        guarded,
      ),
    ).rejects.toThrow(/SELECT \*/);
    const ok = (await dispatchTool(
      "sql_execute",
      { sql: "INSERT INTO customers (email, name) VALUES ('ok@y.z', 'Ok')", dry_run: true },
      guarded,
    )) as any;
    expect(ok.affected_rows).toBe(1);
  });

  it("describe hides indexes on hidden columns; metadata statements are refused", async () => {
    const d = (await dispatchTool("table_describe", { table: "customers" }, guarded)) as any;
    expect(d.indexes.map((i: any) => i.name)).not.toContain("customers_token_idx");
    expect(d.redacted_items).toBeGreaterThan(0);
    await expect(dispatchTool("sql_query", { sql: "SHOW DATABASES" }, guarded)).rejects.toThrow(/disabled/);
  });
});

describe.skipIf(!url)("mysql review fixes round 2 (live)", () => {
  it("a database created after the first query is still outside the allowlist", async () => {
    const guarded = ctxFor("read_write", { MYSQL_SCHEMAS: "shop" });
    await dispatchTool("sql_query", { sql: "SELECT 1 AS warm" }, guarded);
    const root = await mysql.createConnection(url!);
    await root.query("CREATE DATABASE IF NOT EXISTS later_db");
    await root.query("CREATE TABLE IF NOT EXISTS later_db.t (id INT)");
    await root.query("INSERT INTO later_db.t VALUES (1)");
    try {
      await expect(dispatchTool("sql_execute", { sql: "DELETE FROM later_db.t" }, guarded)).rejects.toThrow(
        /allowlist/,
      );
      const [[{ n }]] = (await root.query("SELECT COUNT(*) AS n FROM later_db.t")) as any;
      expect(Number(n)).toBe(1);
    } finally {
      await root.query("DROP DATABASE later_db");
      await root.end();
    }
  });
});

describe.skipIf(!url)("mysql review fixes round 3 (live)", () => {
  const guarded = url
    ? ctxFor("read_write", { MYSQL_SCHEMAS: "shop", MYSQL_HIDDEN_COLUMNS: "api_token" })
    : (undefined as never);

  it("INSERT … () VALUES () counts as positional", async () => {
    await expect(
      dispatchTool("sql_execute", { sql: "INSERT INTO customers () VALUES ()", dry_run: true }, guarded),
    ).rejects.toThrow(/list the columns/);
  });

  it("views over forbidden schemas or hidden columns are refused", async () => {
    const root = await mysql.createConnection(url!);
    await root.query("CREATE OR REPLACE VIEW shop.vault_view AS SELECT secret FROM secret.vault");
    await root.query("CREATE OR REPLACE VIEW shop.token_view AS SELECT api_token AS t FROM shop.customers");
    try {
      await expect(dispatchTool("sql_query", { sql: "SELECT * FROM vault_view" }, guarded)).rejects.toThrow(
        /secret.vault/,
      );
      await expect(dispatchTool("sql_query", { sql: "SELECT t FROM token_view" }, guarded)).rejects.toThrow(
        /hidden/,
      );
      const ok = (await dispatchTool("sql_query", { sql: "SELECT email FROM order_totals" }, guarded)) as any;
      expect(ok.row_count).toBeGreaterThan(0);
    } finally {
      await root.query("DROP VIEW shop.vault_view, shop.token_view");
      await root.end();
    }
  });
});
