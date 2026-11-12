import { beforeEach, describe, expect, it } from "vitest";
import {
  bqRowsToObjects,
  clearTokenCache,
  createBigQueryAdapter,
  createDispatchContext,
  dispatchTool,
  loadRuntimeConfig,
  serviceAccountTokenProvider,
  signServiceAccountJwt,
  toQueryParameters,
  type BigQueryConnection,
} from "@db-mcp/core";

const conn: BigQueryConnection = {
  name: "wh",
  engine: "bigquery",
  access: "read_only",
  projectId: "proj",
  location: "EU",
  accessToken: "tok",
  maxBytesBilled: "1000",
};

type Call = { method: string; url: string; body?: Record<string, unknown> };

function mockFetch(statementType: string, calls: Call[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init?.method ?? "GET", url, body });
    const ok = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });
    if (url.endsWith("/projects/proj/jobs")) {
      return ok({ statistics: { query: { statementType, totalBytesProcessed: "2048" } } });
    }
    if (url.endsWith("/projects/proj/queries")) {
      return ok({
        jobComplete: true,
        jobReference: { projectId: "proj", jobId: "j1", location: "EU" },
        schema: { fields: [{ name: "n", type: "INTEGER" }] },
        rows: [{ f: [{ v: "1" }] }, { f: [{ v: "2" }] }],
        totalRows: "5",
        totalBytesProcessed: "2048",
      });
    }
    return new Response(JSON.stringify({ error: { message: `unexpected ${url}` } }), { status: 404 });
  }) as typeof fetch;
}

describe("BigQuery adapter", () => {
  it("dry-runs, then queries with limits, location and byte cap", async () => {
    const calls: Call[] = [];
    const a = createBigQueryAdapter(conn, { fetch: mockFetch("SELECT", calls) });
    const res = await a.run({
      sql: "SELECT n FROM t",
      maxRows: 2,
      timeoutMs: 1000,
      allow: "read",
      classified: "read",
    });
    expect(calls.map((c) => c.url.split("/").pop())).toEqual(["jobs", "queries"]);
    expect(calls[0]!.body).toMatchObject({
      configuration: { dryRun: true, query: { maximumBytesBilled: "1000" } },
    });
    expect(calls[1]!.body).toMatchObject({ maxResults: 2, location: "EU", useLegacySql: false });
    expect(res).toMatchObject({ row_count: 2, truncated: true, total_rows: 5, rows: [{ n: 1 }, { n: 2 }] });
  });

  it("refuses when dry-run statementType exceeds the allowed class", async () => {
    const calls: Call[] = [];
    const a = createBigQueryAdapter(conn, { fetch: mockFetch("DROP_TABLE", calls) });
    await expect(
      a.run({ sql: "SELECT 1", maxRows: 2, timeoutMs: 1000, allow: "read", classified: "read" }),
    ).rejects.toThrow(/DROP_TABLE/);
    expect(calls).toHaveLength(1); // never executed
  });

  it("explain returns bytes from the dry run", async () => {
    const a = createBigQueryAdapter(conn, { fetch: mockFetch("SELECT", []) });
    await expect(a.explain({ sql: "SELECT 1", timeoutMs: 1000 })).resolves.toMatchObject({
      statement_type: "SELECT",
      total_bytes_processed: 2048,
      total_bytes_processed_human: "2.00 KB",
    });
  });
});

describe("BigQuery values", () => {
  it("converts nested, repeated and typed cells", () => {
    const fields = [
      { name: "id", type: "INT64" },
      { name: "big", type: "INT64" },
      { name: "ok", type: "BOOL" },
      { name: "ts", type: "TIMESTAMP" },
      { name: "tags", type: "STRING", mode: "REPEATED" as const },
      { name: "addr", type: "RECORD", fields: [{ name: "city", type: "STRING" }] },
    ];
    const rows = bqRowsToObjects(fields, [
      {
        f: [
          { v: "7" },
          { v: "9007199254740993" },
          { v: "true" },
          { v: "1700000000123456" },
          { v: [{ v: "a" }, { v: "b" }] },
          { v: { f: [{ v: "Paris" }] } },
        ],
      },
    ]);
    expect(rows[0]).toEqual({
      id: 7,
      big: "9007199254740993",
      ok: true,
      ts: "2023-11-14T22:13:20.123456Z",
      tags: ["a", "b"],
      addr: { city: "Paris" },
    });
  });

  it("builds positional and named parameters", () => {
    expect(toQueryParameters([1, "x", true, 1.5, null])).toMatchObject({
      parameterMode: "POSITIONAL",
      queryParameters: [
        { parameterType: { type: "INT64" }, parameterValue: { value: "1" } },
        { parameterType: { type: "STRING" }, parameterValue: { value: "x" } },
        { parameterType: { type: "BOOL" }, parameterValue: { value: "true" } },
        { parameterType: { type: "FLOAT64" }, parameterValue: { value: "1.5" } },
        { parameterType: { type: "STRING" }, parameterValue: { value: null } },
      ],
    });
    expect(toQueryParameters({ d: { type: "DATE", value: "2024-01-01" }, ids: [1, 2] })).toMatchObject({
      parameterMode: "NAMED",
      queryParameters: [
        { name: "d", parameterType: { type: "DATE" }, parameterValue: { value: "2024-01-01" } },
        {
          name: "ids",
          parameterType: { type: "ARRAY", arrayType: { type: "INT64" } },
          parameterValue: { arrayValues: [{ value: "1" }, { value: "2" }] },
        },
      ],
    });
  });
});

describe("service account auth", () => {
  beforeEach(() => clearTokenCache());

  async function keyPair() {
    const pair = (await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
    const b64 = Buffer.from(der)
      .toString("base64")
      .replace(/(.{64})/g, "$1\n");
    return { pair, pem: `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n` };
  }

  it("signs a verifiable RS256 JWT", async () => {
    const { pair, pem } = await keyPair();
    const jwt = await signServiceAccountJwt({ client_email: "sa@p.iam", private_key: pem }, "scope", 1000);
    const [h, c, s] = jwt.split(".");
    const claims = JSON.parse(Buffer.from(c!, "base64url").toString());
    expect(claims).toMatchObject({ iss: "sa@p.iam", scope: "scope", iat: 1000, exp: 4600 });
    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      pair.publicKey,
      Buffer.from(s!, "base64url"),
      new TextEncoder().encode(`${h}.${c}`),
    );
    expect(valid).toBe(true);
  });

  it("exchanges and caches the token", async () => {
    const { pem } = await keyPair();
    let exchanges = 0;
    const f = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      exchanges++;
      expect(String(init?.body)).toContain(
        "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer",
      );
      return new Response(JSON.stringify({ access_token: "at", expires_in: 3600 }));
    }) as typeof fetch;
    const p = serviceAccountTokenProvider({ client_email: "sa@p.iam", private_key: pem }, f);
    expect(await p.getToken()).toBe("at");
    expect(await p.getToken()).toBe("at");
    expect(exchanges).toBe(1);
  });
});

describe("BigQuery policy and dry run", () => {
  const guarded: BigQueryConnection = {
    ...conn,
    access: "read_write",
    schemas: ["analytics"],
    hiddenColumns: ["email"],
  };

  function fetchWith(dry: Record<string, unknown>, calls: Call[]): typeof fetch {
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({
        method: init?.method ?? "GET",
        url,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      const ok = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });
      if (url.endsWith("/projects/proj/jobs")) return ok({ statistics: { query: dry } });
      if (url.includes("/projects/proj/datasets?")) {
        return ok({
          datasets: [
            { datasetReference: { projectId: "proj", datasetId: "analytics" } },
            { datasetReference: { projectId: "proj", datasetId: "hr" } },
          ],
        });
      }
      if (url.endsWith("/tables/users")) {
        return ok({
          type: "TABLE",
          schema: {
            fields: [
              { name: "id", type: "INT64" },
              { name: "email", type: "STRING" },
            ],
          },
        });
      }
      if (url.includes("/tables/users/data")) return ok({ rows: [{ f: [{ v: "1" }] }], totalRows: "1" });
      if (url.endsWith("/projects/proj/queries"))
        return ok({ jobComplete: true, schema: { fields: [] }, rows: [] });
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
  }

  const run = (a: ReturnType<typeof createBigQueryAdapter>, sql: string, dryRun = false) =>
    a.run({ sql, maxRows: 10, timeoutMs: 1000, allow: "write", classified: "write", dryRun });

  it("dry_run never executes and reports the estimate", async () => {
    const calls: Call[] = [];
    const a = createBigQueryAdapter(guarded, {
      fetch: fetchWith(
        {
          statementType: "DELETE",
          totalBytesProcessed: "10",
          referencedTables: [{ projectId: "proj", datasetId: "analytics", tableId: "t" }],
        },
        calls,
      ),
    });
    const r = await run(a, "DELETE FROM analytics.t WHERE true", true);
    expect(r).toMatchObject({ command: "DELETE", bytes_processed: 10, affected_rows: null, row_count: 0 });
    expect(calls.some((c) => c.url.endsWith("/queries"))).toBe(false);
  });

  it("refuses referenced tables outside the dataset allowlist", async () => {
    const a = createBigQueryAdapter(guarded, {
      fetch: fetchWith(
        {
          statementType: "SELECT",
          referencedTables: [{ projectId: "proj", datasetId: "hr", tableId: "salaries" }],
        },
        [],
      ),
    });
    await expect(run(a, "SELECT * FROM hr.salaries")).rejects.toThrow(/allowlist/);
  });

  it("refuses qualifiers naming a forbidden dataset (e.g. DML targets)", async () => {
    const a = createBigQueryAdapter(guarded, {
      fetch: fetchWith({ statementType: "INSERT", referencedTables: [] }, []),
    });
    await expect(run(a, "INSERT INTO `proj.hr.salaries` (a) VALUES (1)")).rejects.toThrow(/dataset hr/);
  });

  it("refuses hidden columns in the output schema", async () => {
    const a = createBigQueryAdapter(guarded, {
      fetch: fetchWith(
        {
          statementType: "SELECT",
          schema: {
            fields: [
              { name: "id", type: "INT64" },
              { name: "EMAIL", type: "STRING" },
            ],
          },
        },
        [],
      ),
    });
    await expect(run(a, "SELECT * FROM analytics.users")).rejects.toThrow(/hidden/);
  });

  it("table_sample selects only visible fields via tabledata.list", async () => {
    const calls: Call[] = [];
    const a = createBigQueryAdapter(guarded, { fetch: fetchWith({}, calls) });
    const r = await a.sampleTable({ schema: "analytics", table: "users" }, 5, 1000);
    expect(r.columns).toEqual([{ name: "id", type: "INT64" }]);
    expect(calls.find((c) => c.url.includes("/users/data?"))!.url).toContain("selectedFields=id");
    await expect(a.sampleTable({ schema: "hr", table: "users" }, 5, 1000)).rejects.toThrow(/allowlist/);
  });
});

describe("BigQuery positional DML under hidden columns", () => {
  it("refuses INSERT … VALUES and MERGE … INSERT ROW into a table with hidden columns", async () => {
    const calls: Call[] = [];
    const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ method: init?.method ?? "GET", url });
      if (url.endsWith("/tables/users")) {
        return new Response(
          JSON.stringify({
            type: "TABLE",
            schema: {
              fields: [
                { name: "id", type: "INT64" },
                { name: "email", type: "STRING" },
              ],
            },
          }),
        );
      }
      return new Response(JSON.stringify({ statistics: { query: { statementType: "INSERT" } } }));
    }) as typeof fetch;
    const config = loadRuntimeConfig({
      BIGQUERY_PROJECT_ID: "proj",
      BIGQUERY_ACCESS_TOKEN: "t",
      BIGQUERY_ACCESS: "read_write",
      BIGQUERY_HIDDEN_COLUMNS: "email",
    });
    const ctx = createDispatchContext(config, (c) =>
      createBigQueryAdapter(c as BigQueryConnection, { fetch: f }),
    );
    await expect(
      dispatchTool("sql_execute", { sql: "INSERT INTO analytics.users VALUES (1, 'a@b.c')" }, ctx),
    ).rejects.toThrow(/list the columns/);
    await expect(
      dispatchTool(
        "sql_execute",
        {
          sql: "MERGE analytics.users t USING analytics.staging s ON t.id = s.id WHEN NOT MATCHED THEN INSERT ROW",
        },
        ctx,
      ),
    ).rejects.toThrow(/list the columns/);
    expect(calls.some((c) => c.url.endsWith("/queries"))).toBe(false);
  });
});

describe("BigQuery describe redaction", () => {
  it("masks a STRUCT parent type that lists a hidden child", async () => {
    const f = (async () =>
      new Response(
        JSON.stringify({
          type: "TABLE",
          schema: {
            fields: [
              { name: "id", type: "INT64" },
              {
                name: "address",
                type: "RECORD",
                fields: [
                  { name: "secret", type: "STRING" },
                  { name: "city", type: "STRING" },
                ],
              },
            ],
          },
        }),
      )) as typeof fetch;
    const config = loadRuntimeConfig({
      BIGQUERY_PROJECT_ID: "proj",
      BIGQUERY_ACCESS_TOKEN: "t",
      BIGQUERY_HIDDEN_COLUMNS: "secret",
    });
    const ctx = createDispatchContext(config, (c) =>
      createBigQueryAdapter(c as BigQueryConnection, { fetch: f }),
    );
    const d = (await dispatchTool("table_describe", { table: "ds.users" }, ctx)) as any;
    expect(d.columns.map((c: any) => c.name)).toEqual(["id", "address", "address.city"]);
    expect(JSON.stringify(d.columns)).not.toContain("secret");
  });
});

describe("BigQuery cross-project allowlist", () => {
  it("describes an explicitly allowlisted dataset in another project", async () => {
    const f = (async () =>
      new Response(
        JSON.stringify({ type: "TABLE", schema: { fields: [{ name: "id", type: "INT64" }] } }),
      )) as typeof fetch;
    const config = loadRuntimeConfig({
      BIGQUERY_PROJECT_ID: "other-project",
      BIGQUERY_ACCESS_TOKEN: "t",
      BIGQUERY_DATASETS: "allowed-project.analytics",
    });
    const ctx = createDispatchContext(config, (c) =>
      createBigQueryAdapter(c as BigQueryConnection, { fetch: f }),
    );
    const d = (await dispatchTool(
      "table_describe",
      { table: "allowed-project.analytics.users" },
      ctx,
    )) as any;
    expect(d.project_id).toBe("allowed-project");
    await expect(dispatchTool("table_describe", { table: "analytics.users" }, ctx)).rejects.toThrow(
      /allowlist/,
    );
  });

  it("columns_search keeps rows from an explicitly allowlisted cross-project dataset", async () => {
    const queryJson = {
      jobComplete: true,
      schema: {
        fields: [
          { name: "schema", type: "STRING" },
          { name: "table", type: "STRING" },
          { name: "column", type: "STRING" },
          { name: "type", type: "STRING" },
        ],
      },
      rows: [{ f: [{ v: "analytics" }, { v: "users" }, { v: "email" }, { v: "STRING" }] }],
    };
    const f = (async () => new Response(JSON.stringify(queryJson), { status: 200 })) as typeof fetch;
    const config = loadRuntimeConfig({
      BIGQUERY_PROJECT_ID: "other-project",
      BIGQUERY_ACCESS_TOKEN: "t",
      BIGQUERY_DATASETS: "allowed-project.analytics",
    });
    const ctx = createDispatchContext(config, (c) =>
      createBigQueryAdapter(c as BigQueryConnection, { fetch: f }),
    );
    for (const args of [{ schema: "allowed-project.analytics", pattern: "email" }, { pattern: "email" }]) {
      const r = (await dispatchTool("columns_search", args, ctx)) as any;
      expect(r.count).toBe(1);
      expect(r.columns[0]).toMatchObject({
        schema: "analytics",
        table: "users",
        column: "email",
        project_id: "allowed-project",
      });
    }
  });
});

describe("BigQuery scoped rules on dry-run output fields", () => {
  const scoped: BigQueryConnection = { ...conn, access: "read_only", hiddenColumns: ["users.email"] };
  const runA = (a: ReturnType<typeof createBigQueryAdapter>, sql: string) =>
    a.run({ sql, maxRows: 10, timeoutMs: 1000, allow: "read", classified: "read" });

  function dryFetch(dry: Record<string, unknown>): typeof fetch {
    return (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/queries")) {
        const fields = (dry as { schema?: { fields?: unknown[] } }).schema?.fields ?? [];
        return new Response(
          JSON.stringify({ jobComplete: true, schema: { fields }, rows: [], totalRows: "0" }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ statistics: { query: dry } }), { status: 200 });
    }) as typeof fetch;
  }

  it("a table-scoped rule does not hit fields of unrelated tables", async () => {
    const a = createBigQueryAdapter(scoped, {
      fetch: dryFetch({
        statementType: "SELECT",
        referencedTables: [{ projectId: "proj", datasetId: "analytics", tableId: "orders" }],
        schema: { fields: [{ name: "email", type: "STRING" }] },
      }),
    });
    await expect(runA(a, "SELECT email FROM analytics.orders")).resolves.toMatchObject({
      row_count: 0,
      columns: [{ name: "email", type: "STRING" }],
    });
  });

  it("scoped rules still refuse fields when their table is referenced", async () => {
    const a = createBigQueryAdapter(scoped, {
      fetch: dryFetch({
        statementType: "SELECT",
        referencedTables: [{ projectId: "proj", datasetId: "analytics", tableId: "users" }],
        schema: { fields: [{ name: "email", type: "STRING" }] },
      }),
    });
    await expect(runA(a, "SELECT email FROM analytics.users")).rejects.toThrow(/hidden/);
  });

  it("schema-qualified rules check the referenced dataset too", async () => {
    const schemaScoped: BigQueryConnection = {
      ...conn,
      access: "read_only",
      hiddenColumns: ["private.users.ssn"],
    };
    const dry = {
      statementType: "SELECT",
      referencedTables: [{ projectId: "proj", datasetId: "public", tableId: "users" }],
      schema: { fields: [{ name: "ssn", type: "STRING" }] },
    };
    // public.users does not match private.users.ssn: visible.
    const ok = createBigQueryAdapter(schemaScoped, { fetch: dryFetch(dry) });
    await expect(runA(ok, "SELECT ssn FROM public.users")).resolves.toMatchObject({ row_count: 0 });
    // private.users matches: refused.
    const hidden = createBigQueryAdapter(schemaScoped, {
      fetch: dryFetch({
        ...dry,
        referencedTables: [{ projectId: "proj", datasetId: "private", tableId: "users" }],
      }),
    });
    await expect(runA(hidden, "SELECT ssn FROM private.users")).rejects.toThrow(/hidden/);
  });

  it("a join touching the scoped table stays refused", async () => {
    const a = createBigQueryAdapter(scoped, {
      fetch: dryFetch({
        statementType: "SELECT",
        referencedTables: [
          { projectId: "proj", datasetId: "analytics", tableId: "orders" },
          { projectId: "proj", datasetId: "analytics", tableId: "users" },
        ],
        schema: { fields: [{ name: "email", type: "STRING" }] },
      }),
    });
    await expect(
      runA(a, "SELECT o.email FROM analytics.orders o JOIN analytics.users u ON o.user_id = u.id"),
    ).rejects.toThrow(/hidden/);
  });
});
