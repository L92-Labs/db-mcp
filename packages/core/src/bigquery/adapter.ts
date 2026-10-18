import { columnHidden, policyFor, schemaAllowed } from "../policy.js";
import { classAllowed, maxClass, qualifierTokens, splitStatements } from "../sql/classify.js";
import type {
  BigQueryConnection,
  DbAdapter,
  QueryResult,
  RunInput,
  SqlParams,
  StatementClass,
  TableRef,
} from "../types.js";
import {
  parseServiceAccount,
  serviceAccountTokenProvider,
  staticTokenProvider,
  type TokenProvider,
} from "./auth.js";
import { bqRowsToObjects, bqTypeLabel, flattenFields, toQueryParameters, type BqField } from "./values.js";

const API = "https://bigquery.googleapis.com/bigquery/v2";
const LABELS = { client: "db-mcp" };
const POLL_WAIT_MS = 10_000;

type Json = Record<string, unknown>;

type DatasetRef = { projectId: string; datasetId: string };

type QueryResponse = {
  jobComplete?: boolean;
  jobReference?: { projectId: string; jobId: string; location?: string };
  schema?: { fields?: BqField[] };
  rows?: Array<{ f?: Array<{ v: unknown }> }>;
  totalRows?: string;
  numDmlAffectedRows?: string;
  totalBytesProcessed?: string;
  cacheHit?: boolean;
  pageToken?: string;
};

type DryRunJob = {
  statistics?: {
    totalBytesProcessed?: string;
    query?: {
      statementType?: string;
      totalBytesProcessed?: string;
      referencedTables?: Array<{ projectId: string; datasetId: string; tableId: string }>;
      schema?: { fields?: BqField[] };
    };
  };
};

/** Server-side truth for access control: map the dry-run statementType to a statement class. */
export function bigQueryStatementClass(statementType: string | undefined): StatementClass {
  const t = (statementType ?? "").toUpperCase();
  if (t === "SELECT") return "read";
  if (t === "INSERT" || t === "UPDATE" || t === "DELETE" || t === "MERGE") return "write";
  return "admin";
}

function humanBytes(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  let n = Number(raw);
  if (!Number.isFinite(n)) return null;
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let u = 0;
  while (n >= 1024 && u < units.length - 1) {
    n /= 1024;
    u++;
  }
  return `${n.toFixed(u === 0 ? 0 : 2)} ${units[u]}`;
}

function likeToRegExp(pattern: string): RegExp {
  if (!pattern.includes("%")) {
    return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  }
  const body = pattern
    .split("%")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/_/g, "."))
    .join(".*");
  return new RegExp(`^${body}$`, "i");
}

function quoteBq(path: string): string {
  return `\`${path.replace(/`/g, "")}\``;
}

export function createBigQueryAdapter(
  connection: BigQueryConnection,
  opts: { fetch?: typeof fetch; tokens?: TokenProvider } = {},
): DbAdapter {
  const fetchImpl = opts.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const tokens =
    opts.tokens ??
    (connection.credentialsJson
      ? serviceAccountTokenProvider(parseServiceAccount(connection.credentialsJson), fetchImpl)
      : staticTokenProvider(connection.accessToken!));
  const project = connection.projectId;
  const policy = policyFor(connection);

  async function api<T>(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string | undefined>,
  ): Promise<T> {
    const url = new URL(`${API}${path}`);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) url.searchParams.set(k, v);
    const res = await fetchImpl(url.toString(), {
      method,
      headers: {
        authorization: `Bearer ${await tokens.getToken()}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: unknown = {};
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = { raw: text };
      }
    }
    if (!res.ok) {
      const err = (json as { error?: { message?: string } }).error;
      throw new Error(`BigQuery ${res.status}: ${err?.message ?? text.slice(0, 300)}`);
    }
    return json as T;
  }

  function datasetRef(schema: string | undefined): DatasetRef {
    const ds = schema?.trim() || connection.defaultDataset;
    if (!ds)
      throw new Error("BigQuery needs a dataset: pass schema or set default_dataset on the connection");
    const parts = ds.replace(/`/g, "").split(".");
    if (parts.length === 1) return { projectId: project, datasetId: parts[0]! };
    if (parts.length === 2) return { projectId: parts[0]!, datasetId: parts[1]! };
    throw new Error(`invalid dataset reference: ${ds}`);
  }

  function tablePath(ref: TableRef): DatasetRef & { tableId: string } {
    return { ...datasetRef(ref.schema), tableId: ref.table.replace(/`/g, "") };
  }

  function queryBase(params: SqlParams | undefined) {
    return {
      useLegacySql: false,
      ...toQueryParameters(params),
      ...(connection.defaultDataset ? { defaultDataset: datasetRef(connection.defaultDataset) } : {}),
      ...(connection.maxBytesBilled ? { maximumBytesBilled: connection.maxBytesBilled } : {}),
    };
  }

  async function dryRun(sql: string, params: SqlParams | undefined): Promise<DryRunJob> {
    return api<DryRunJob>("POST", `/projects/${project}/jobs`, {
      jobReference: { projectId: project, ...(connection.location ? { location: connection.location } : {}) },
      configuration: { dryRun: true, labels: LABELS, query: { query: sql, ...queryBase(params) } },
    });
  }

  async function query(
    sql: string,
    params: SqlParams | undefined,
    maxRows: number,
    timeoutMs: number,
  ): Promise<QueryResponse> {
    const deadline = Date.now() + timeoutMs;
    let res = await api<QueryResponse>("POST", `/projects/${project}/queries`, {
      query: sql,
      ...queryBase(params),
      maxResults: maxRows,
      timeoutMs: Math.min(timeoutMs, POLL_WAIT_MS),
      labels: LABELS,
      formatOptions: { useInt64Timestamp: true },
      ...(connection.location ? { location: connection.location } : {}),
    });
    while (!res.jobComplete) {
      const job = res.jobReference;
      if (!job) throw new Error("BigQuery returned an incomplete job without a reference");
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        await api("POST", `/projects/${job.projectId}/jobs/${job.jobId}/cancel`, undefined, {
          location: job.location,
        }).catch(() => undefined);
        throw new Error(`BigQuery job ${job.jobId} exceeded ${timeoutMs} ms and was cancelled`);
      }
      res = await api<QueryResponse>("GET", `/projects/${job.projectId}/queries/${job.jobId}`, undefined, {
        location: job.location,
        maxResults: String(maxRows),
        timeoutMs: String(Math.min(remaining, POLL_WAIT_MS)),
        "formatOptions.useInt64Timestamp": "true",
      });
    }
    return res;
  }

  function shape(
    res: QueryResponse,
    maxRows: number,
    cls: StatementClass,
    started: number,
    statementType?: string,
  ): QueryResult {
    const fields = res.schema?.fields ?? [];
    const rows = bqRowsToObjects(fields, res.rows).slice(0, maxRows);
    const total = res.totalRows === undefined ? rows.length : Number(res.totalRows);
    return {
      columns: fields.map((f) => ({ name: f.name, type: bqTypeLabel(f) })),
      rows,
      row_count: rows.length,
      truncated: total > rows.length,
      total_rows: total,
      affected_rows: res.numDmlAffectedRows === undefined ? null : Number(res.numDmlAffectedRows),
      command: statementType,
      statement_class: cls,
      bytes_processed: res.totalBytesProcessed === undefined ? null : Number(res.totalBytesProcessed),
      cache_hit: res.cacheHit ?? null,
      job_id: res.jobReference?.jobId ?? null,
      duration_ms: Date.now() - started,
    };
  }

  /** Schema/column policy from the dry run: referenced datasets + output columns, plus qualifiers in the SQL. */
  async function enforcePolicy(sql: string, dry: DryRunJob): Promise<void> {
    if (!policy) return;
    const q = dry.statistics?.query;
    for (const t of q?.referencedTables ?? []) {
      if (!schemaAllowed(policy, `${t.projectId}.${t.datasetId}`)) {
        throw new Error(
          `${t.datasetId}.${t.tableId} is outside the dataset allowlist of connection "${connection.name}"`,
        );
      }
    }
    if (policy.schemas) {
      const known = new Set((await datasetNames()).map((d) => d.toLowerCase()));
      for (const qualifier of splitStatements(sql, "bigquery").flatMap(qualifierTokens)) {
        if (known.has(qualifier.toLowerCase()) && !schemaAllowed(policy, qualifier)) {
          throw new Error(`dataset ${qualifier} is outside the allowlist of connection "${connection.name}"`);
        }
      }
    }
    for (const f of flattenFields(q?.schema?.fields ?? [])) {
      if (f.name.split(".").some((part) => columnHidden(policy, { column: part }))) {
        throw new Error(`result column ${f.name} is hidden on connection "${connection.name}"`);
      }
    }
  }

  let datasetCache: string[] | undefined;
  async function datasetNames(): Promise<string[]> {
    datasetCache ??= (await listDatasets(true)).map((d) => String(d.name));
    return datasetCache;
  }

  async function run(
    input: Pick<RunInput, "sql" | "params" | "maxRows" | "timeoutMs" | "allow" | "classified" | "dryRun">,
  ): Promise<QueryResult> {
    const started = Date.now();
    // Dry run first: free, validates SQL, and gives the authoritative statementType.
    const dry = await dryRun(input.sql, input.params);
    const statementType = dry.statistics?.query?.statementType;
    const cls = maxClass(input.classified, bigQueryStatementClass(statementType));
    if (!classAllowed(cls, input.allow)) {
      throw new Error(
        `BigQuery dry run reports statementType ${statementType ?? "unknown"} (${cls}); this call allows ${input.allow} only`,
      );
    }
    await enforcePolicy(input.sql, dry);
    if (input.dryRun) {
      const q = dry.statistics?.query;
      const bytes = q?.totalBytesProcessed ?? dry.statistics?.totalBytesProcessed;
      return {
        columns: (q?.schema?.fields ?? []).map((f) => ({ name: f.name, type: bqTypeLabel(f) })),
        rows: [],
        row_count: 0,
        truncated: false,
        affected_rows: null,
        command: statementType,
        statement_class: cls,
        bytes_processed: bytes === undefined ? null : Number(bytes),
        referenced_tables: (q?.referencedTables ?? []).map(
          (t) => `${t.projectId}.${t.datasetId}.${t.tableId}`,
        ),
        note: "BigQuery dry run: validated and estimated only; nothing executed, affected rows unknown",
        duration_ms: Date.now() - started,
      };
    }
    const res = await query(input.sql, input.params, input.maxRows, input.timeoutMs);
    return shape(res, input.maxRows, cls, started, statementType);
  }

  async function listDatasets(includeHidden: boolean): Promise<Json[]> {
    const out: Json[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 20; page++) {
      const res = await api<{
        datasets?: Array<{
          datasetReference: DatasetRef;
          location?: string;
          friendlyName?: string;
          labels?: Json;
        }>;
        nextPageToken?: string;
      }>("GET", `/projects/${project}/datasets`, undefined, {
        maxResults: "1000",
        all: includeHidden ? "true" : undefined,
        pageToken,
      });
      for (const d of res.datasets ?? []) {
        out.push({
          name: d.datasetReference.datasetId,
          project_id: d.datasetReference.projectId,
          location: d.location ?? null,
          friendly_name: d.friendlyName ?? null,
          labels: d.labels ?? null,
        });
      }
      pageToken = res.nextPageToken;
      if (!pageToken) break;
    }
    return out;
  }

  async function listTablesIn(ds: DatasetRef, limit: number): Promise<Json[]> {
    const out: Json[] = [];
    let pageToken: string | undefined;
    while (out.length < limit) {
      const res = await api<{
        tables?: Array<{
          tableReference: { tableId: string };
          type?: string;
          creationTime?: string;
          timePartitioning?: Json;
          rangePartitioning?: Json;
          clustering?: { fields?: string[] };
        }>;
        nextPageToken?: string;
      }>("GET", `/projects/${ds.projectId}/datasets/${ds.datasetId}/tables`, undefined, {
        maxResults: "1000",
        pageToken,
      });
      for (const t of res.tables ?? []) {
        out.push({
          schema: ds.datasetId,
          name: t.tableReference.tableId,
          kind: (t.type ?? "TABLE").toLowerCase(),
          created: t.creationTime ? new Date(Number(t.creationTime)).toISOString() : null,
          partitioning: t.timePartitioning ?? t.rangePartitioning ?? null,
          clustering: t.clustering?.fields ?? null,
        });
      }
      pageToken = res.nextPageToken;
      if (!pageToken) break;
    }
    return out;
  }

  async function getTable(ref: TableRef): Promise<Json & { schema?: { fields?: BqField[] }; type?: string }> {
    const t = tablePath(ref);
    return api("GET", `/projects/${t.projectId}/datasets/${t.datasetId}/tables/${t.tableId}`);
  }

  return {
    engine: "bigquery",

    async info() {
      await api("GET", `/projects/${project}/datasets`, undefined, { maxResults: "1" });
      return {
        project_id: project,
        location: connection.location ?? null,
        default_dataset: connection.defaultDataset ?? null,
        principal: tokens.principal,
        max_bytes_billed: connection.maxBytesBilled ?? null,
        reachable: true,
        enforcement:
          "every statement is dry-run first; its statementType must fit the access level. Grant the service account only the IAM roles you need (dataViewer + jobUser for read-only).",
      };
    },

    async listSchemas({ includeSystem }) {
      return listDatasets(includeSystem);
    },

    async listTables({ schema, pattern, includeViews, limit }) {
      const datasets =
        schema || connection.defaultDataset
          ? [datasetRef(schema)]
          : (await listDatasets(false))
              .slice(0, 50)
              .map((d) => ({ projectId: String(d.project_id), datasetId: String(d.name) }));
      const re = pattern ? likeToRegExp(pattern) : null;
      const out: Json[] = [];
      for (const ds of datasets) {
        const tables = await listTablesIn(ds, 10_000);
        for (const t of tables) {
          if (re && !re.test(String(t.name))) continue;
          if (!includeViews && (t.kind === "view" || t.kind === "materialized_view")) continue;
          out.push(t);
          if (out.length >= limit) return out;
        }
      }
      return out;
    },

    async describeTable(ref) {
      const t = await getTable(ref);
      const path = tablePath(ref);
      const view = t.view as { query?: string } | undefined;
      const mview = t.materializedView as { query?: string } | undefined;
      return {
        schema: path.datasetId,
        project_id: path.projectId,
        name: path.tableId,
        kind: String(t.type ?? "TABLE").toLowerCase(),
        description: t.description ?? null,
        num_rows: t.numRows === undefined ? null : Number(t.numRows),
        num_bytes: t.numBytes === undefined ? null : Number(t.numBytes),
        location: t.location ?? null,
        created: t.creationTime ? new Date(Number(t.creationTime)).toISOString() : null,
        modified: t.lastModifiedTime ? new Date(Number(t.lastModifiedTime)).toISOString() : null,
        partitioning: t.timePartitioning ?? t.rangePartitioning ?? null,
        require_partition_filter: t.requirePartitionFilter ?? false,
        clustering: (t.clustering as { fields?: string[] } | undefined)?.fields ?? null,
        labels: t.labels ?? null,
        columns: flattenFields(t.schema?.fields ?? []),
        ...(view?.query || mview?.query ? { view_definition: view?.query ?? mview?.query } : {}),
      };
    },

    async sampleTable(ref, limit, timeoutMs) {
      const started = Date.now();
      const path = tablePath(ref);
      if (!schemaAllowed(policy, `${path.projectId}.${path.datasetId}`)) {
        throw new Error(
          `dataset ${path.datasetId} is outside the allowlist of connection "${connection.name}"`,
        );
      }
      const t = await getTable(ref);
      const allFields = t.schema?.fields ?? [];
      // Drop any top-level field that is, or contains, a hidden column.
      const fields = allFields.filter(
        (f) =>
          !flattenFields([f]).some((x) =>
            x.name
              .split(".")
              .some((part) =>
                columnHidden(policy, { schema: path.datasetId, table: path.tableId, column: part }),
              ),
          ),
      );
      if (fields.length === 0) throw new Error(`every column of ${path.datasetId}.${path.tableId} is hidden`);
      const restricted = fields.length < allFields.length;
      if (String(t.type ?? "TABLE") === "TABLE") {
        // tabledata.list is free (no bytes billed), unlike SELECT * … LIMIT.
        const data = await api<{ rows?: Array<{ f?: Array<{ v: unknown }> }>; totalRows?: string }>(
          "GET",
          `/projects/${path.projectId}/datasets/${path.datasetId}/tables/${path.tableId}/data`,
          undefined,
          {
            maxResults: String(limit),
            "formatOptions.useInt64Timestamp": "true",
            selectedFields: restricted ? fields.map((f) => f.name).join(",") : undefined,
          },
        );
        const rows = bqRowsToObjects(fields, data.rows).slice(0, limit);
        const total = data.totalRows === undefined ? rows.length : Number(data.totalRows);
        return {
          columns: fields.map((f) => ({ name: f.name, type: bqTypeLabel(f) })),
          rows,
          row_count: rows.length,
          truncated: total > rows.length,
          total_rows: total,
          statement_class: "read",
          bytes_processed: 0,
          duration_ms: Date.now() - started,
        };
      }
      const select = restricted ? fields.map((f) => quoteBq(f.name)).join(", ") : "*";
      const sql = `SELECT ${select} FROM ${quoteBq(`${path.projectId}.${path.datasetId}.${path.tableId}`)} LIMIT ${Math.floor(limit)}`;
      return run({ sql, maxRows: limit, timeoutMs, allow: "read", classified: "read" });
    },

    async searchColumns({ pattern, schema, limit }) {
      let source: string;
      if (schema || connection.defaultDataset) {
        const ds = datasetRef(schema);
        source = `${quoteBq(`${ds.projectId}.${ds.datasetId}`)}.INFORMATION_SCHEMA.COLUMNS`;
      } else if (connection.location) {
        source = `${quoteBq(project)}.${quoteBq(`region-${connection.location.toLowerCase()}`)}.INFORMATION_SCHEMA.COLUMNS`;
      } else {
        throw new Error(
          "BigQuery columns_search needs schema (dataset), default_dataset or location on the connection",
        );
      }
      const like = pattern.includes("%") ? pattern : `%${pattern.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
      const res = await query(
        `SELECT table_schema AS schema, table_name AS \`table\`, column_name AS \`column\`, data_type AS type
         FROM ${source}
         WHERE LOWER(column_name) LIKE LOWER(@pattern)
         ORDER BY table_schema, table_name, ordinal_position
         LIMIT @limit`,
        { pattern: like, limit },
        limit,
        30_000,
      );
      return bqRowsToObjects(res.schema?.fields ?? [], res.rows);
    },

    run,

    async explain({ sql, params }) {
      const dry = await dryRun(sql, params);
      const q = dry.statistics?.query;
      const bytes = q?.totalBytesProcessed ?? dry.statistics?.totalBytesProcessed;
      return {
        statement_type: q?.statementType ?? null,
        engine_statement_class: bigQueryStatementClass(q?.statementType),
        total_bytes_processed: bytes === undefined ? null : Number(bytes),
        total_bytes_processed_human: humanBytes(bytes),
        referenced_tables: (q?.referencedTables ?? []).map(
          (t) => `${t.projectId}.${t.datasetId}.${t.tableId}`,
        ),
        columns: (q?.schema?.fields ?? []).map((f) => ({ name: f.name, type: bqTypeLabel(f) })),
        max_bytes_billed: connection.maxBytesBilled ?? null,
      };
    },
  };
}
