import { describe, expect, it } from "vitest";
import { assertSqlAllowed, classifySql } from "@db-mcp/core";

const pg = (sql: string) => classifySql(sql, "postgres").class;
const bq = (sql: string) => classifySql(sql, "bigquery").class;

describe("classifySql (postgres)", () => {
  it.each([
    "SELECT 1",
    "select * from users where id = $1;",
    "  -- hi\n/* block /* nested */ */ SELECT 'DELETE FROM x; DROP TABLE y'",
    "WITH t AS (SELECT 1) SELECT * FROM t",
    "(SELECT 1) UNION (SELECT 2)",
    "VALUES (1), (2)",
    "TABLE users",
    "SHOW search_path",
    "EXPLAIN SELECT 1",
    "EXPLAIN (FORMAT JSON) DELETE FROM users",
    "EXPLAIN ANALYZE SELECT 1",
    'SELECT "delete" FROM t',
    "SELECT $$ DROP TABLE x; $$ AS body",
    "SELECT $fn$ ; INSERT $fn$",
    "SELECT E'it\\'s ; DELETE'",
  ])("read: %s", (sql) => {
    expect(pg(sql)).toBe("read");
  });

  it.each([
    "INSERT INTO t VALUES (1)",
    "update t set a = 1",
    "DELETE FROM t",
    "MERGE INTO t USING s ON true WHEN MATCHED THEN DELETE",
    "WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d",
    "SELECT * FROM t FOR UPDATE",
    "EXPLAIN ANALYZE DELETE FROM t",
    "EXPLAIN (ANALYZE, BUFFERS) UPDATE t SET a = 1",
  ])("write: %s", (sql) => {
    expect(pg(sql)).toBe("write");
  });

  it.each([
    "DROP TABLE t",
    "CREATE TABLE t (id int)",
    "ALTER TABLE t ADD COLUMN x int",
    "TRUNCATE t",
    "GRANT SELECT ON t TO bob",
    "VACUUM",
    "SET search_path = x",
    "BEGIN",
    "COMMIT",
    "COPY t FROM '/etc/passwd'",
    "CALL do_things()",
    "DO $$ BEGIN DELETE FROM t; END $$",
    "SELECT * INTO new_t FROM t",
    "SELECT pg_terminate_backend(123)",
    "SELECT set_config('x', 'y', false)",
    "SELECT 1; SELECT 2",
    "SELECT 1; DROP TABLE t",
    "REFRESH MATERIALIZED VIEW mv",
  ])("admin: %s", (sql) => {
    expect(pg(sql)).toBe("admin");
  });

  it("ignores trailing semicolons and comments", () => {
    expect(classifySql("SELECT 1; ; -- done", "postgres").statements).toHaveLength(1);
  });

  it("rejects empty and unterminated input", () => {
    expect(() => classifySql("  -- nothing ", "postgres")).toThrow(/empty/);
    expect(() => classifySql("SELECT 'oops", "postgres")).toThrow(/unterminated/);
    expect(() => classifySql("SELECT $$ oops", "postgres")).toThrow(/unterminated/);
  });
});

describe("classifySql (bigquery)", () => {
  it("reads", () => {
    expect(bq('SELECT * FROM `proj.ds.t` WHERE name = "DELETE"')).toBe("read");
    expect(bq("# comment\nSELECT 1")).toBe("read");
    expect(bq("SELECT '''multi\n;line DROP'''")).toBe("read");
    expect(bq("SELECT r'\\d+;'")).toBe("read");
    expect(bq("FROM t |> WHERE x > 1")).toBe("read");
  });
  it("writes and admin", () => {
    expect(bq("INSERT INTO ds.t (a) VALUES (1)")).toBe("write");
    expect(bq("CREATE OR REPLACE TABLE ds.t AS SELECT 1 AS a")).toBe("admin");
    expect(bq("DECLARE x INT64; SET x = 1; SELECT x")).toBe("admin");
    expect(bq("EXPORT DATA OPTIONS(uri='gs://b/*') AS SELECT 1")).toBe("admin");
  });
});

describe("assertSqlAllowed", () => {
  const ctx = { connection: "main", tool: "sql_query" };
  it("allows reads under read", () => {
    expect(assertSqlAllowed("SELECT 1", "postgres", "read", ctx).class).toBe("read");
  });
  it("explains why writes are refused", () => {
    expect(() => assertSqlAllowed("DELETE FROM t", "postgres", "read", ctx)).toThrow(
      /not read-only.*sql_execute on a connection with read_write/,
    );
    expect(() =>
      assertSqlAllowed("DROP TABLE t", "postgres", "write", { connection: "main", tool: "sql_execute" }),
    ).toThrow(/requires admin access/);
    expect(() => assertSqlAllowed("SELECT 1; SELECT 2", "postgres", "write", ctx)).toThrow(
      /one statement per call/,
    );
  });
  it("admin allows scripts", () => {
    expect(
      assertSqlAllowed("CREATE TABLE a(); DROP TABLE a", "postgres", "admin", ctx).statements,
    ).toHaveLength(2);
  });
});
