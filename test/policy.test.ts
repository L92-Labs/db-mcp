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
  it("always keeps at least one row", () => {
    expect(limitRows([{ a: "z".repeat(5000) }], 1_000, 10_000).rows).toHaveLength(1);
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
