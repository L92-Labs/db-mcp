/** BigQuery REST (f/v rows, typed query parameters) ↔ plain JSON. */

export type BqField = {
  name: string;
  type: string;
  mode?: "NULLABLE" | "REQUIRED" | "REPEATED";
  fields?: BqField[];
  description?: string;
};

type Cell = { v: unknown };

function scalar(type: string, v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") return v;
  switch (type) {
    case "INTEGER":
    case "INT64": {
      const n = Number(v);
      return Number.isSafeInteger(n) ? n : v;
    }
    case "FLOAT":
    case "FLOAT64": {
      const n = Number(v);
      return Number.isFinite(n) ? n : v;
    }
    case "BOOLEAN":
    case "BOOL":
      return v === "true";
    case "TIMESTAMP": {
      // formatOptions.useInt64Timestamp → microseconds since epoch
      if (/^-?\d+$/.test(v)) {
        const micros = BigInt(v);
        const ms = Number(micros / 1000n);
        const iso = new Date(ms).toISOString();
        const extra = Number(((micros % 1000n) + 1000n) % 1000n);
        return extra ? iso.replace("Z", `${String(extra).padStart(3, "0")}Z`) : iso;
      }
      const secs = Number(v);
      return Number.isFinite(secs) ? new Date(secs * 1000).toISOString() : v;
    }
    default:
      return v;
  }
}

function convert(field: BqField, v: unknown): unknown {
  if (field.mode === "REPEATED") {
    if (!Array.isArray(v)) return [];
    return (v as Cell[]).map((c) => convert({ ...field, mode: "NULLABLE" }, c?.v));
  }
  if (field.type === "RECORD" || field.type === "STRUCT") {
    if (v === null || v === undefined) return null;
    const cells = (v as { f?: Cell[] }).f ?? [];
    return rowToObject(field.fields ?? [], cells);
  }
  return scalar(field.type, v);
}

function rowToObject(fields: BqField[], cells: Cell[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  fields.forEach((f, i) => {
    out[f.name] = convert(f, cells[i]?.v);
  });
  return out;
}

export function bqRowsToObjects(
  fields: BqField[],
  rows: Array<{ f?: Cell[] }> | undefined,
): Record<string, unknown>[] {
  return (rows ?? []).map((r) => rowToObject(fields, r.f ?? []));
}

export function bqTypeLabel(field: BqField): string {
  const base =
    field.type === "RECORD" || field.type === "STRUCT"
      ? `STRUCT<${(field.fields ?? []).map((f) => `${f.name} ${bqTypeLabel(f)}`).join(", ")}>`
      : field.type;
  return field.mode === "REPEATED" ? `ARRAY<${base}>` : base;
}

/** Flatten nested schema into dotted paths for table_describe. */
export function flattenFields(
  fields: BqField[],
  prefix = "",
): Array<{ name: string; type: string; mode: string; description: string | null }> {
  const out: Array<{ name: string; type: string; mode: string; description: string | null }> = [];
  for (const f of fields) {
    const name = prefix ? `${prefix}.${f.name}` : f.name;
    out.push({ name, type: bqTypeLabel(f), mode: f.mode ?? "NULLABLE", description: f.description ?? null });
    if (f.fields?.length) out.push(...flattenFields(f.fields, name));
  }
  return out;
}

type ParamType = { type: string; arrayType?: ParamType };
type ParamValue = { value?: string | null; arrayValues?: ParamValue[] };
export type BqQueryParameter = { name?: string; parameterType: ParamType; parameterValue: ParamValue };

function isTyped(v: unknown): v is { type: string; value: unknown } {
  return (
    v !== null &&
    typeof v === "object" &&
    !Array.isArray(v) &&
    typeof (v as { type?: unknown }).type === "string" &&
    "value" in (v as object) &&
    Object.keys(v as object).length === 2
  );
}

function inferType(v: unknown): ParamType {
  if (isTyped(v)) {
    const t = v.type.toUpperCase();
    if (t.startsWith("ARRAY<") && t.endsWith(">"))
      return { type: "ARRAY", arrayType: { type: t.slice(6, -1) } };
    return { type: t };
  }
  if (typeof v === "boolean") return { type: "BOOL" };
  if (typeof v === "number") return { type: Number.isInteger(v) ? "INT64" : "FLOAT64" };
  if (typeof v === "bigint") return { type: "INT64" };
  if (Array.isArray(v)) {
    const firstNonNull = v.find((x) => x !== null && x !== undefined);
    return {
      type: "ARRAY",
      arrayType: firstNonNull === undefined ? { type: "STRING" } : inferType(firstNonNull),
    };
  }
  if (v !== null && typeof v === "object") return { type: "JSON" };
  return { type: "STRING" };
}

function toParamValue(v: unknown): ParamValue {
  const raw = isTyped(v) ? v.value : v;
  if (raw === null || raw === undefined) return { value: null };
  if (Array.isArray(raw)) return { arrayValues: raw.map(toParamValue) };
  if (typeof raw === "object") return { value: JSON.stringify(raw) };
  return { value: String(raw) };
}

export function toQueryParameters(params: unknown[] | Record<string, unknown> | undefined): {
  parameterMode?: "POSITIONAL" | "NAMED";
  queryParameters?: BqQueryParameter[];
} {
  if (params === undefined) return {};
  if (Array.isArray(params)) {
    if (params.length === 0) return {};
    return {
      parameterMode: "POSITIONAL",
      queryParameters: params.map((p) => ({ parameterType: inferType(p), parameterValue: toParamValue(p) })),
    };
  }
  const entries = Object.entries(params);
  if (entries.length === 0) return {};
  return {
    parameterMode: "NAMED",
    queryParameters: entries.map(([name, p]) => ({
      name: name.replace(/^@/, ""),
      parameterType: inferType(p),
      parameterValue: toParamValue(p),
    })),
  };
}
