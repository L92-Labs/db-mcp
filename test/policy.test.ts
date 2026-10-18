import { describe, expect, it } from "vitest";
import {
  buildAuditEntry,
  capAccess,
  classifySql,
  columnHidden,
  limitRows,
  loadRuntimeConfig,
  policyFor,
  assertSqlPolicy,
  hasStarProjection,
  mentionsHidden,
  positionalInsertTarget,
  positionalMergeTarget,
  schemaAllowed,
  splitStatements,
  type ConnectionConfig,
} from "@db-mcp/core";

const my = (sql: string) => classifySql(sql, "mysql").class;

describe("classifySql (mysql)", () => {
  it.each([
    "SELECT * FROM `orders` WHERE note = 'it\\'s; DROP'",
    "SELECT 1 -- comment ; DROP TABLE x",
    "SELECT 1 # comment",
    "SHOW TABLES",
    "DESCRIBE customers",
    "DESC shop.customers",
    "EXPLAIN FORMAT=JSON DELETE FROM t",
    "TABLE customers",
    "SELECT 1--1",
  ])("read: %s", (sql) => expect(my(sql)).toBe("read"));

  it.each([
    "INSERT INTO t VALUES (1)",
    "REPLACE INTO t VALUES (1)",
    "UPDATE t SET a = 1",
    "SELECT * FROM t FOR UPDATE",
  ])("write: %s", (sql) => expect(my(sql)).toBe("write"));

  it.each([
    "DROP TABLE t",
    "SELECT * FROM t INTO OUTFILE '/tmp/x'",
    "SELECT LOAD_FILE('/etc/passwd')",
    "SELECT GET_LOCK('x', 10)",
    "SET GLOBAL read_only = 0",
    "SELECT 1 /*!50000 ; DROP TABLE t */",
    "/*!40101 DROP TABLE t */",
    "LOAD DATA INFILE 'x' INTO TABLE t",
    "CALL p()",
  ])("admin: %s", (sql) => expect(my(sql)).toBe("admin"));
});

const conn = (extra: Partial<ConnectionConfig>): ConnectionConfig =>
  ({
    name: "c",
    engine: "postgres",
    access: "read_write",
    url: "postgres://x",
    ...extra,
  }) as ConnectionConfig;

describe("policy", () => {
  const policy = policyFor(
    conn({ schemas: ["shop"], hiddenColumns: ["password", "customers.api_token", "*secret*"] }),
  )!;

  it("matches hidden columns by column, table.column and glob", () => {
    expect(columnHidden(policy, { schema: "shop", table: "users", column: "PASSWORD" })).toBe(true);
    expect(columnHidden(policy, { schema: "shop", table: "customers", column: "api_token" })).toBe(true);
    expect(columnHidden(policy, { schema: "shop", table: "orders", column: "api_token" })).toBe(false);
    expect(columnHidden(policy, { column: "client_secret_v2" })).toBe(true);
    expect(columnHidden(policy, { schema: "shop", table: "orders", column: "email" })).toBe(false);
  });

  it("refuses hidden identifiers and admin statements in SQL", () => {
    const check = (sql: string) =>
      assertSqlPolicy(sql, "postgres", policy, classifySql(sql, "postgres").statements, "c");
    expect(() => check("SELECT email FROM shop.customers")).not.toThrow();
    expect(() => check('SELECT "api_token" AS t FROM shop.customers')).toThrow(/hidden column/);
    expect(() => check("SELECT password FROM users")).toThrow(/hidden column/);
    expect(() => check("SELECT 'password' AS label")).not.toThrow(); // literals are fine
    expect(() => check("DROP TABLE shop.orders")).toThrow(/admin statements/);
    expect(() => check("EXPLAIN SELECT 1")).toThrow(/sql_explain/);
  });

  it("refuses INFORMATION_SCHEMA under a schema allowlist (mysql/bigquery)", () => {
    const p = policyFor(conn({ engine: "mysql", schemas: ["shop"] } as Partial<ConnectionConfig>))!;
    const sql = "SELECT * FROM information_schema.tables";
    expect(() => assertSqlPolicy(sql, "mysql", p, classifySql(sql, "mysql").statements, "c")).toThrow(
      /allowlist/,
    );
  });

  it("parses policies from env", () => {
    const c = loadRuntimeConfig({
      DATABASE_URL: "postgres://x",
      DATABASE_SCHEMAS: "public, shop",
      DB_HIDDEN_COLUMNS: "password,*token*",
      DB_CONNECTIONS_JSON: "",
    });
    expect(c.connections.postgres).toMatchObject({
      schemas: ["public", "shop"],
      hiddenColumns: ["password", "*token*"],
    });
    expect(
      () => loadRuntimeConfig({ DATABASE_URL: "x", DB_HIDDEN_COLUMNS: "a.b.c.d" }).connections.postgres,
    ).not.toThrow(); // validated when the policy is built
    expect(() => policyFor(conn({ hiddenColumns: ["a.b.c.d"] }))).toThrow(/invalid hidden column/);
  });
});

describe("limitRows", () => {
  it("cuts long cells and drops rows past the byte budget", () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({
      i,
      text: "x".repeat(100),
      doc: { big: "y".repeat(500) },
    }));
    const { rows: out, stats } = limitRows(rows, 2_000, 50);
    expect(out[0]!.text).toMatch(/^x{50}…\[\+50 chars\]$/);
    expect(typeof out[0]!.doc).toBe("string");
    expect(stats.cellsTruncated).toBeGreaterThan(0);
    expect(out.length).toBeLessThan(50);
    expect(stats.rowsDropped).toBe(50 - out.length);
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(2_000);
  });
  it("shrinks an oversized first row to fit, or drops it", () => {
    const one = limitRows([{ a: "z".repeat(5000) }], 1_000, 10_000);
    expect(one.rows).toHaveLength(1);
    expect(JSON.stringify(one.rows).length).toBeLessThanOrEqual(1_000);
    const wide = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`column_${i}`, i]));
    const dropped = limitRows([wide], 1_000, 2_000);
    expect(dropped.rows).toHaveLength(0);
    expect(dropped.stats.rowsDropped).toBe(1);
  });
});

describe("capAccess", () => {
  it("lowers every connection", () => {
    const c = capAccess(loadRuntimeConfig({ DATABASE_URL: "postgres://x", DB_ACCESS: "admin" }), "read_only");
    expect(c.connections.postgres!.access).toBe("read_only");
  });
});

describe("audit entry", () => {
  it("hashes SQL in meta mode and includes it in sql mode", async () => {
    const base = {
      principal: "github:ada",
      tool: "sql_execute",
      args: { sql: "DELETE FROM t", connection: "main" },
      result: { statement_class: "write", affected_rows: 3, row_count: 0, dry_run: true },
      startedAt: Date.now(),
    };
    const meta = await buildAuditEntry({ ...base, mode: "meta" });
    expect(meta).toMatchObject({
      principal: "github:ada",
      connection: "main",
      affected_rows: 3,
      dry_run: true,
      ok: true,
    });
    expect(meta.sql).toBeUndefined();
    expect(meta.sql_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect((await buildAuditEntry({ ...base, mode: "sql" })).sql).toBe("DELETE FROM t");
    const failed = await buildAuditEntry({
      ...base,
      mode: "meta",
      result: undefined,
      error: new Error("nope"),
    });
    expect(failed).toMatchObject({ ok: false, error: "nope" });
  });
});

describe("policy (review fixes)", () => {
  const tokens = (sql: string, engine: "postgres" | "mysql" | "bigquery" = "mysql") =>
    splitStatements(sql, engine)[0]!;

  it("table-scoped rules only fire when their table is named", () => {
    const p = policyFor(conn({ hiddenColumns: ["customers.api_token"] }))!;
    const check = (sql: string) =>
      assertSqlPolicy(sql, "postgres", p, classifySql(sql, "postgres").statements, "c");
    expect(() => check("SELECT api_token FROM orders")).not.toThrow();
    expect(() => check("SELECT api_token FROM customers")).toThrow(/customers.api_token/);
  });

  it("Postgres schema names are exact; BigQuery accepts project.dataset", () => {
    const pg = policyFor(conn({ schemas: ["shop"] }))!;
    expect(schemaAllowed(pg, "shop")).toBe(true);
    expect(schemaAllowed(pg, "SHOP")).toBe(false);
    expect(schemaAllowed(pg, "other.shop")).toBe(false);
    const bq = policyFor(conn({ engine: "bigquery", schemas: ["analytics"] } as Partial<ConnectionConfig>))!;
    expect(schemaAllowed(bq, "proj.analytics")).toBe(true);
    expect(schemaAllowed(bq, "proj.hr")).toBe(false);
  });

  it("finds positional INSERT/REPLACE/MERGE targets", () => {
    expect(positionalInsertTarget(tokens("INSERT INTO shop.customers VALUES (1)"))).toEqual({
      schema: "shop",
      table: "customers",
    });
    expect(positionalInsertTarget(tokens("REPLACE customers SELECT * FROM x"))).toEqual({
      table: "customers",
    });
    expect(positionalInsertTarget(tokens("INSERT INTO customers (id, email) VALUES (1, 'a')"))).toBeNull();
    expect(positionalInsertTarget(tokens("INSERT INTO customers SET email = 'a'"))).toBeNull();
    expect(positionalInsertTarget(tokens("INSERT INTO `proj.ds.users` VALUES (1)", "bigquery"))).toEqual({
      schema: "proj.ds",
      table: "users",
    });
    expect(
      positionalMergeTarget(
        tokens("MERGE ds.users t USING s ON t.id = s.id WHEN NOT MATCHED THEN INSERT ROW", "bigquery"),
      ),
    ).toEqual({ schema: "ds", table: "users" });
    expect(
      positionalMergeTarget(
        tokens("MERGE ds.users t USING s ON true WHEN NOT MATCHED THEN INSERT (id) VALUES (1)", "bigquery"),
      ),
    ).toBeNull();
  });

  it("detects SELECT * projections but not multiplication or COUNT(*)", () => {
    expect(hasStarProjection(tokens("INSERT INTO a SELECT * FROM b"))).toBe(true);
    expect(hasStarProjection(tokens("INSERT INTO a SELECT b.* FROM b"))).toBe(true);
    expect(hasStarProjection(tokens("INSERT INTO a SELECT id, * FROM b"))).toBe(true);
    expect(hasStarProjection(tokens("UPDATE t SET a = a * 2"))).toBe(false);
    expect(hasStarProjection(tokens("INSERT INTO a SELECT COUNT(*) FROM b"))).toBe(false);
  });

  it("refuses SELECT * in writes and MySQL metadata statements on guarded connections", () => {
    const p = policyFor(
      conn({ engine: "mysql", hiddenColumns: ["api_token"] } as Partial<ConnectionConfig>),
    )!;
    const check = (sql: string) =>
      assertSqlPolicy(sql, "mysql", p, classifySql(sql, "mysql").statements, "c");
    expect(() => check("INSERT INTO archive SELECT * FROM customers")).toThrow(/SELECT \*/);
    expect(() => check("SHOW DATABASES")).toThrow(/disabled/);
    expect(() => check("DESCRIBE customers")).toThrow(/disabled/);
    expect(() => check("SELECT * FROM customers")).not.toThrow(); // reads are checked on result columns
  });

  it("mentionsHidden respects table scope", () => {
    const p = policyFor(conn({ hiddenColumns: ["customers.api_token"] }))!;
    expect(mentionsHidden(p, "CREATE INDEX i ON shop.customers USING btree (api_token)", "customers")).toBe(
      true,
    );
    expect(mentionsHidden(p, "CREATE INDEX i ON shop.orders USING btree (api_token)", "orders")).toBe(false);
  });
});
