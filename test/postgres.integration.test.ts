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

function ctxFor(access: string, extra: Record<string, string> = {}) {
  const config = loadRuntimeConfig({ DATABASE_URL: url!, DB_ACCESS: access, DB_MAX_ROWS: "100", ...extra });
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
  const ro = url ? ctxFor("read_only") : (undefined as never);
  const rw = url ? ctxFor("read_write") : (undefined as never);
  const admin = url ? ctxFor("admin") : (undefined as never);

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

describe.skipIf(!url)("postgres dry run, policy, budget (live)", () => {
  const rw = url ? ctxFor("read_write") : (undefined as never);
  const admin = url ? ctxFor("admin") : (undefined as never);
  const guarded = url
    ? ctxFor("read_write", { DATABASE_SCHEMAS: "shop", DATABASE_HIDDEN_COLUMNS: "api_token" })
    : (undefined as never);

  const count = async () =>
    ((await dispatchTool("sql_query", { sql: "SELECT count(*)::int AS n FROM shop.orders" }, rw)) as any)
      .rows[0].n;

  it("dry_run reports affected rows and rolls back", async () => {
    const before = await count();
    const r = (await dispatchTool(
      "sql_execute",
      { sql: "DELETE FROM shop.orders WHERE status = 'paid'", dry_run: true },
      rw,
    )) as any;
    expect(r).toMatchObject({ dry_run: true, rolled_back: true, affected_rows: 2, command: "DELETE" });
    expect(await count()).toBe(before);
  });

  it("admin dry_run rolls back DDL and refuses transaction control", async () => {
    await dispatchTool(
      "sql_execute",
      { sql: "CREATE TABLE shop.tmp_dry (a int); INSERT INTO shop.tmp_dry VALUES (1)", dry_run: true },
      admin,
    );
    const t = (await dispatchTool("tables_list", { schema: "shop", pattern: "tmp_dry" }, admin)) as any;
    expect(t.count).toBe(0);
    await expect(
      dispatchTool("sql_execute", { sql: "COMMIT; DROP TABLE shop.orders", dry_run: true }, admin),
    ).rejects.toThrow(/cannot contain COMMIT/);
  });

  it("schema allowlist filters metadata and refuses other schemas in SQL", async () => {
    const schemas = (await dispatchTool("schemas_list", {}, guarded)) as any;
    expect(schemas.schemas.map((s: any) => s.name)).toEqual(["shop"]);
    const tables = (await dispatchTool("tables_list", {}, guarded)) as any;
    expect(tables.tables.every((t: any) => t.schema === "shop")).toBe(true);
    await expect(dispatchTool("table_describe", { table: "secret.vault" }, guarded)).rejects.toThrow(
      /allowlist/,
    );
    await expect(dispatchTool("sql_query", { sql: "SELECT * FROM secret.vault" }, guarded)).rejects.toThrow(
      /allowlist/,
    );
    await expect(
      dispatchTool(
        "sql_query",
        { sql: "SELECT * FROM shop.orders o JOIN secret.vault v ON v.id = o.id" },
        guarded,
      ),
    ).rejects.toThrow(/allowlist/);
    // search_path is pinned to the allowlist, so an unqualified name cannot reach public/secret
    const ok = (await dispatchTool("sql_query", { sql: "SELECT count(*) AS n FROM orders" }, guarded)) as any;
    expect(ok.rows[0].n).toBe("3");
    await expect(dispatchTool("sql_execute", { sql: "DELETE FROM secret.vault" }, guarded)).rejects.toThrow(
      /allowlist/,
    );
  });

  it("hidden columns: metadata, SELECT *, aliases, whole-row, sample", async () => {
    const d = (await dispatchTool("table_describe", { table: "shop.customers" }, guarded)) as any;
    expect(d.columns.map((c: any) => c.name)).not.toContain("api_token");
    expect(d.hidden_columns).toBe(1);
    await expect(dispatchTool("sql_query", { sql: "SELECT * FROM shop.customers" }, guarded)).rejects.toThrow(
      /hidden/,
    );
    await expect(
      dispatchTool("sql_query", { sql: "SELECT c.* FROM shop.customers c" }, guarded),
    ).rejects.toThrow(/hidden/);
    await expect(
      dispatchTool("sql_query", { sql: "SELECT row_to_json(c) FROM shop.customers c" }, guarded),
    ).rejects.toThrow(/hidden/);
    await expect(
      dispatchTool("sql_query", { sql: "SELECT api_token FROM shop.customers" }, guarded),
    ).rejects.toThrow(/hidden/);
    const ok = (await dispatchTool(
      "sql_query",
      { sql: "SELECT c.email AS e FROM shop.customers c" },
      guarded,
    )) as any;
    expect(ok.row_count).toBe(2);
    const s = (await dispatchTool("table_sample", { table: "shop.customers" }, guarded)) as any;
    expect(s.columns.map((c: any) => c.name)).toEqual(["id", "email", "name", "created_at"]);
    const cols = (await dispatchTool("columns_search", { pattern: "token" }, guarded)) as any;
    expect(cols.count).toBe(0);
    await expect(
      dispatchTool("sql_execute", { sql: "CREATE TABLE shop.x (a int)" }, guarded),
    ).rejects.toThrow(/disabled|admin/);
  });

  it("byte budget truncates big results", async () => {
    const small = ctxFor("read_only", { DB_MAX_RESULT_BYTES: "2000", DB_MAX_CELL_CHARS: "20" });
    const r = (await dispatchTool(
      "sql_query",
      { sql: "SELECT g, repeat('x', 100) AS pad FROM generate_series(1, 100) g" },
      small,
    )) as any;
    expect(r).toMatchObject({ truncated: true, truncated_by: "bytes" });
    expect(r.rows[0].pad).toMatch(/…\[\+80 chars\]$/);
    expect(r.row_count).toBeLessThan(100);
  });
});

describe.skipIf(!url)("postgres review fixes (live)", () => {
  const guarded = url
    ? ctxFor("read_write", { DATABASE_SCHEMAS: "shop", DATABASE_HIDDEN_COLUMNS: "customers.api_token" })
    : (undefined as never);

  it("columns_search fills its limit from allowed schemas only", async () => {
    const r = (await dispatchTool("columns_search", { pattern: "id", limit: 2 }, guarded)) as any;
    expect(r.count).toBe(2);
    expect(r.columns.every((c: any) => c.schema === "shop")).toBe(true);
  });

  it("describe redacts indexes on hidden columns and keeps the rest", async () => {
    const d = (await dispatchTool("table_describe", { table: "shop.customers" }, guarded)) as any;
    expect(d.indexes.map((i: any) => i.name)).not.toContain("customers_token_idx");
    expect(d.indexes.map((i: any) => i.name)).toContain("customers_pkey");
    expect(d.referenced_by[0].table).toBe("shop.orders");
  });

  it("positional INSERT into a table with hidden columns is refused", async () => {
    await expect(
      dispatchTool(
        "sql_execute",
        { sql: "INSERT INTO shop.customers VALUES (99, 'x@y.z', 'X', 'tok', now())" },
        guarded,
      ),
    ).rejects.toThrow(/list the columns/);
    const ok = (await dispatchTool(
      "sql_execute",
      { sql: "INSERT INTO shop.customers (email) VALUES ('ok@y.z')", dry_run: true },
      guarded,
    )) as any;
    expect(ok.affected_rows).toBe(1);
  });

  it("a scoped rule leaves same-named columns on other tables usable", async () => {
    const r = (await dispatchTool("sql_query", { sql: "SELECT 'x' AS api_token" }, guarded)) as any;
    expect(r.rows).toEqual([{ api_token: "x" }]);
  });
});

describe.skipIf(!url)("postgres review fixes round 2 (live)", () => {
  const admin = url ? ctxFor("admin") : (undefined as never);
  const guarded = url
    ? ctxFor("read_write", { DATABASE_SCHEMAS: "shop", DATABASE_HIDDEN_COLUMNS: "customers.api_token" })
    : (undefined as never);

  it("unqualified positional INSERT resolves through the allowlisted search_path", async () => {
    await dispatchTool(
      "sql_execute",
      { sql: "CREATE TABLE IF NOT EXISTS public.customers (id int, email text)" },
      admin,
    );
    try {
      await expect(
        dispatchTool(
          "sql_execute",
          { sql: "INSERT INTO customers VALUES (99, 'x@y.z', 'X', 'tok', now())", dry_run: true },
          guarded,
        ),
      ).rejects.toThrow(/list the columns/);
    } finally {
      await dispatchTool("sql_execute", { sql: "DROP TABLE public.customers" }, admin);
    }
  });

  it("string constants in the plan are not column references", async () => {
    const r = (await dispatchTool(
      "sql_query",
      { sql: "SELECT 'api_token' AS label, email FROM shop.customers LIMIT 1" },
      guarded,
    )) as any;
    expect(r.rows[0].label).toBe("api_token");
  });
});

describe.skipIf(!url)("postgres review fixes round 3 (live)", () => {
  it("dry-run DML with RETURNING beyond max_rows still reports affected rows", async () => {
    const rw = ctxFor("read_write", { DB_MAX_ROWS: "1" });
    const r = (await dispatchTool(
      "sql_execute",
      { sql: "UPDATE shop.orders SET status = status RETURNING id", dry_run: true },
      rw,
    )) as any;
    expect(r).toMatchObject({ affected_rows: 3, row_count: 1, truncated: true, rolled_back: true });
  });
});

describe.skipIf(!url)("postgres review fixes round 4 (live)", () => {
  const guarded = url
    ? ctxFor("read_write", { DATABASE_SCHEMAS: "shop", DATABASE_HIDDEN_COLUMNS: "customers.api_token" })
    : (undefined as never);
  it("a positional INSERT after a data-modifying CTE is refused", async () => {
    await expect(
      dispatchTool(
        "sql_execute",
        {
          sql: "WITH x AS (INSERT INTO shop.orders (customer_id, total_cents) VALUES (1, 1) RETURNING id) INSERT INTO shop.customers VALUES (99, 'x@y.z', 'X', 'tok', now())",
          dry_run: true,
        },
        guarded,
      ),
    ).rejects.toThrow(/list the columns/);
  });
});

describe.skipIf(!url)("postgres review fixes round 5 (live)", () => {
  it("dry-run INSERT flags sequences; setval is refused", async () => {
    const rw = ctxFor("read_write");
    const r = (await dispatchTool(
      "sql_execute",
      { sql: "INSERT INTO shop.customers (email) VALUES ('seq@y.z')", dry_run: true },
      rw,
    )) as any;
    expect(r.note).toMatch(/sequences/);
    await expect(
      dispatchTool("sql_execute", { sql: "SELECT setval('shop.orders_id_seq', 1000)", dry_run: true }, rw),
    ).rejects.toThrow(/setval/);
  });
});

describe.skipIf(!url)("postgres review fixes round 7 (live)", () => {
  it("admin dry_run refuses irreversible side-effect functions", async () => {
    const admin = ctxFor("admin");
    await expect(
      dispatchTool("sql_execute", { sql: "SELECT pg_advisory_lock(42)", dry_run: true }, admin),
    ).rejects.toThrow(/pg_advisory_lock\(\): its effect is not rolled back/);
    await expect(
      dispatchTool("sql_execute", { sql: "SELECT pg_terminate_backend(0)", dry_run: true }, admin),
    ).rejects.toThrow(/pg_terminate_backend/);
  });
});
