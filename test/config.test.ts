import { describe, expect, it } from "vitest";
import { loadRuntimeConfig, parseAccess, resolveConnection } from "@db-mcp/core";

describe("loadRuntimeConfig", () => {
  it("defaults to read_only with DATABASE_URL", () => {
    const c = loadRuntimeConfig({ DATABASE_URL: "postgres://u:p@h/db" });
    expect(c.defaultConnection).toBe("postgres");
    expect(c.connections.postgres).toMatchObject({
      engine: "postgres",
      access: "read_only",
      url: "postgres://u:p@h/db",
    });
    expect(c.maxRows).toBe(200);
    expect(c.statementTimeoutMs).toBe(30_000);
  });

  it("DB_ACCESS sets the default, per-connection access overrides it", () => {
    const c = loadRuntimeConfig({
      DB_ACCESS: "rw",
      DB_CONNECTIONS_JSON: JSON.stringify({
        app: { engine: "postgres", url: "postgres://x" },
        prod: { engine: "pg", url: "postgres://y", access: "read_only" },
        wh: { engine: "bigquery", project_id: "p", access_token: "t", access: "admin" },
      }),
      DB_DEFAULT_CONNECTION: "prod",
    });
    expect(c.connections.app!.access).toBe("read_write");
    expect(c.connections.prod!.access).toBe("read_only");
    expect(c.connections.wh).toMatchObject({ engine: "bigquery", access: "admin", projectId: "p" });
    expect(resolveConnection(c).name).toBe("prod");
  });

  it("supports Hyperdrive bindings and BigQuery shorthand side by side", () => {
    const c = loadRuntimeConfig({
      DATABASE_HYPERDRIVE: "HYPERDRIVE",
      BIGQUERY_PROJECT_ID: "proj",
      BIGQUERY_CREDENTIALS_JSON: '{"client_email":"a","private_key":"b"}',
      BIGQUERY_ACCESS: "read_write",
      BIGQUERY_MAX_BYTES_BILLED: "1000000000",
    });
    expect(c.connections.postgres).toMatchObject({ hyperdrive: "HYPERDRIVE", access: "read_only" });
    expect(c.connections.bigquery).toMatchObject({ access: "read_write", maxBytesBilled: "1000000000" });
  });

  it("rejects bad values", () => {
    expect(() => loadRuntimeConfig({})).toThrow(/Configure/);
    expect(() => loadRuntimeConfig({ DATABASE_URL: "x", DB_ACCESS: "maybe" })).toThrow(/access must be/);
    expect(() => loadRuntimeConfig({ DATABASE_URL: "x", DB_MAX_ROWS: "0" })).toThrow(/DB_MAX_ROWS/);
    expect(() => loadRuntimeConfig({ DB_CONNECTIONS_JSON: '{"a":{"engine":"oracle","url":"x"}}' })).toThrow(
      /unknown engine/,
    );
    expect(() =>
      loadRuntimeConfig({ DB_CONNECTIONS_JSON: '{"a":{"engine":"bigquery","project_id":"p"}}' }),
    ).toThrow(/credentials_json or access_token/);
    expect(() => loadRuntimeConfig({ DATABASE_URL: "x", DB_DEFAULT_CONNECTION: "nope" })).toThrow(
      /not found/,
    );
  });

  it("parses access aliases", () => {
    expect(parseAccess("READ-ONLY", "admin")).toBe("read_only");
    expect(parseAccess("write", "read_only")).toBe("read_write");
    expect(parseAccess(undefined, "admin")).toBe("admin");
  });
});
