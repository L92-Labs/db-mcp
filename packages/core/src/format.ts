/** Make driver values JSON-safe and compact (Buffers, bigint, Dates, huge blobs). */
const MAX_BINARY_BYTES = 256;

export function toJsonValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? String(value) : value.toISOString();
  if (value instanceof Uint8Array) {
    const hex = Array.from(value.subarray(0, MAX_BINARY_BYTES), (b) => b.toString(16).padStart(2, "0")).join(
      "",
    );
    return value.length > MAX_BINARY_BYTES ? `\\x${hex}… (${value.length} bytes)` : `\\x${hex}`;
  }
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = toJsonValue(v);
    return out;
  }
  return value;
}

export function jsonToolResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
  };
}

export function errorToolResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: message }],
  };
}

/** "users" → substring match; "user%" → LIKE pattern as given. `_` is literal unless % present. */
export function likePattern(pattern: string): string {
  if (pattern.includes("%")) return pattern;
  return `%${pattern.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}

/** Split "a.b" / "a.b.c" refs when no explicit schema is given. Quoted names are not split. */
export function splitQualified(
  schema: string | undefined,
  table: string,
): { schema?: string; table: string } {
  if (schema?.trim()) return { schema: schema.trim(), table: table.trim() };
  const t = table.trim();
  if (/["`]/.test(t) || !t.includes(".")) return { table: t };
  const idx = t.lastIndexOf(".");
  return { schema: t.slice(0, idx), table: t.slice(idx + 1) };
}

export type LimitStats = { cellsTruncated: number; rowsDropped: number };

/**
 * Keep a result inside the response budget: long strings / big JSON cells are cut to
 * `maxCellChars`, then trailing rows are dropped until the rows fit in `maxBytes`.
 */
export function limitRows(
  rows: Record<string, unknown>[],
  maxBytes: number,
  maxCellChars: number,
): { rows: Record<string, unknown>[]; stats: LimitStats } {
  const stats: LimitStats = { cellsTruncated: 0, rowsDropped: 0 };
  const cut = (v: unknown): unknown => {
    if (typeof v === "string") {
      if (v.length <= maxCellChars) return v;
      stats.cellsTruncated++;
      return `${v.slice(0, maxCellChars)}…[+${v.length - maxCellChars} chars]`;
    }
    if (v !== null && typeof v === "object") {
      const json = JSON.stringify(v);
      if (json.length <= maxCellChars) return v;
      stats.cellsTruncated++;
      return `${json.slice(0, maxCellChars)}…[+${json.length - maxCellChars} chars]`;
    }
    return v;
  };
  const out: Record<string, unknown>[] = [];
  let size = 2;
  for (const row of rows) {
    const next: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) next[k] = cut(v);
    const bytes = new TextEncoder().encode(JSON.stringify(next)).length + 1;
    if (size + bytes > maxBytes && out.length > 0) {
      stats.rowsDropped = rows.length - out.length;
      break;
    }
    size += bytes;
    out.push(next);
  }
  return { rows: out, stats };
}
