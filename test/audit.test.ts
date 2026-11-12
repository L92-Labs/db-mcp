import { describe, expect, it } from "vitest";
import { buildAuditEntry } from "@db-mcp/core";

const base = {
  principal: "bearer",
  tool: "sql_execute",
  args: { sql: "INSERT INTO t VALUES ('secret-value')", connection: "main" },
  startedAt: Date.now(),
};

describe("audit error sanitization (review round 7)", () => {
  it("meta mode keeps only a stable code for driver errors, never their text", async () => {
    const pg = Object.assign(new Error('syntax error at or near "secret-value"'), {
      code: "42601",
      severity: "ERROR",
    });
    const entry = await buildAuditEntry({ ...base, mode: "meta", error: pg });
    expect(entry.error).toBe("database error 42601 (set DB_AUDIT_LOG=sql for the message)");

    const my = Object.assign(new Error("Duplicate entry 'secret-value' for key 't.PRIMARY'"), {
      code: "ER_DUP_ENTRY",
      errno: 1062,
      sqlState: "23000",
    });
    expect(await buildAuditEntry({ ...base, mode: "meta", error: my })).toMatchObject({
      error: "database error ER_DUP_ENTRY (set DB_AUDIT_LOG=sql for the message)",
    });

    const bq = new Error("BigQuery 400: duplicate column names are not allowed: secret-value");
    expect(await buildAuditEntry({ ...base, mode: "meta", error: bq })).toMatchObject({
      error: "database error 400 (set DB_AUDIT_LOG=sql for the message)",
    });

    const refused = Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
    expect(await buildAuditEntry({ ...base, mode: "meta", error: refused })).toMatchObject({
      error: "database error ECONNREFUSED (set DB_AUDIT_LOG=sql for the message)",
    });

    const thrown = "raw driver string";
    expect(await buildAuditEntry({ ...base, mode: "meta", error: thrown })).toMatchObject({
      error: "database error (set DB_AUDIT_LOG=sql for the message)",
    });
  });

  it("meta mode keeps db-mcp's own guardrail messages", async () => {
    const entry = await buildAuditEntry({
      ...base,
      mode: "meta",
      error: new Error('table "t" has hidden columns; list the columns you write'),
    });
    expect(entry.error).toMatch(/hidden columns/);
  });

  it("sql mode keeps the raw driver message (explicit opt-in)", async () => {
    const pg = Object.assign(new Error("duplicate key value violates unique constraint"), {
      code: "23505",
      severity: "ERROR",
    });
    expect(await buildAuditEntry({ ...base, mode: "sql", error: pg })).toMatchObject({
      error: "duplicate key value violates unique constraint",
    });
  });
});
