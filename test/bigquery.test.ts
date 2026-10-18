import { beforeEach, describe, expect, it } from "vitest";
import {
  bqRowsToObjects,
  clearTokenCache,
  createBigQueryAdapter,
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
