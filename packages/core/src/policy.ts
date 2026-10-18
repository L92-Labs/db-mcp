import { identifierTokens, splitStatements, type StatementInfo, type Token } from "./sql/classify.js";
import type { ConnectionConfig, Engine } from "./types.js";

/**
 * Per-connection guardrails on top of access levels:
 *  - `schemas`: allowlist of schemas / datasets the agent may see or touch
 *  - `hiddenColumns`: column patterns removed from metadata and refused in SQL
 *
 * Enforced by metadata filtering, an identifier scan of the SQL, and engine checks
 * (Postgres: EXPLAIN plan relations/columns; BigQuery: dry-run referenced tables and
 * output schema; MySQL: qualified names + result column origins). Not a substitute for
 * database grants: SQL inside functions/procedures is not inspected.
 */

type Rule = { schema?: RegExp; table?: RegExp; column: RegExp; source: string };

export type Policy = {
  engine: Engine;
  schemas: string[] | null;
  rules: Rule[];
};

function glob(pattern: string): RegExp {
  const body = pattern
    .split("*")
    .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}$`, "i");
}

function parseRule(source: string): Rule {
  const parts = source.split(".").map((p) => p.trim());
  if (parts.some((p) => !p) || parts.length > 3) {
    throw new Error(
      `invalid hidden column pattern "${source}" (use column, table.column or schema.table.column)`,
    );
  }
  const column = glob(parts[parts.length - 1]!);
  if (parts.length === 1) return { column, source };
  if (parts.length === 2) return { table: glob(parts[0]!), column, source };
  return { schema: glob(parts[0]!), table: glob(parts[1]!), column, source };
}

export function policyFor(connection: ConnectionConfig): Policy | null {
  const schemas = connection.schemas?.length ? connection.schemas : null;
  const rules = (connection.hiddenColumns ?? []).map(parseRule);
  if (!schemas && rules.length === 0) return null;
  return { engine: connection.engine, schemas, rules };
}

/**
 * Engine semantics: Postgres schema names are exact (quoted "SHOP" ≠ shop); MySQL compares
 * case-insensitively; BigQuery datasets may be written "dataset" or "project.dataset".
 */
export function schemaAllowed(policy: Policy | null, schema: string | null | undefined): boolean {
  if (!policy?.schemas || schema === null || schema === undefined) return true;
  if (policy.engine === "postgres") return policy.schemas.includes(schema);
  if (policy.engine === "mysql") return policy.schemas.some((a) => a.toLowerCase() === schema.toLowerCase());
  const dataset = (name: string) => name.split(".").pop()!;
  return policy.schemas.some((allowed) => {
    if (allowed.includes(".") && schema.includes(".")) return allowed === schema;
    return dataset(allowed) === dataset(schema);
  });
}

export function columnHidden(
  policy: Policy | null,
  ref: { schema?: string | null; table?: string | null; column: string },
): boolean {
  if (!policy) return false;
  return policy.rules.some(
    (r) =>
      r.column.test(ref.column) &&
      (!r.table || (ref.table ? r.table.test(ref.table) : true)) &&
      (!r.schema || (ref.schema ? r.schema.test(ref.schema.split(".").pop()!) : true)),
  );
}

export function describePolicy(policy: Policy | null) {
  return policy ? { schemas: policy.schemas, hidden_columns: policy.rules.map((r) => r.source) } : null;
}

/**
 * Does `text` (an index definition, view SQL…) mention a hidden column? Scoped rules
 * (`table.column`) only count when their table name appears too.
 */
export function mentionsHidden(policy: Policy | null, text: string, table?: string): boolean {
  if (!policy || policy.rules.length === 0) return false;
  const words = text.match(/[A-Za-z_][A-Za-z0-9_$]*/g) ?? [];
  return policy.rules.some(
    (r) =>
      words.some((w) => r.column.test(w)) &&
      (!r.table || (table !== undefined && r.table.test(table)) || words.some((w) => r.table!.test(w))),
  );
}

function isPunct(t: Token | undefined, value: string): boolean {
  return t?.kind === "punct" && t.value === value;
}

function isWord(t: Token | undefined, value?: string): boolean {
  return t?.kind === "word" && (value === undefined || t.value === value);
}

/** `*` used as a select-list projection (`SELECT *`, `t.*`, `, *`) rather than multiplication or COUNT(*). */
export function hasStarProjection(tokens: Token[]): boolean {
  return tokens.some((t, i) => {
    if (!isPunct(t, "*")) return false;
    const prev = tokens[i - 1];
    const next = tokens[i + 1];
    const afterSelect = isWord(prev, "SELECT") || isWord(prev, "DISTINCT") || isWord(prev, "ALL");
    const qualified = isPunct(prev, ".");
    const listed = isPunct(prev, ",") && (isWord(next, "FROM") || isPunct(next, ","));
    return afterSelect || qualified || listed;
  });
}

/** Target of `INSERT/REPLACE [INTO] t VALUES|SELECT …` without a column list, if any. */
export function positionalInsertTarget(tokens: Token[]): { schema?: string; table: string } | null {
  if (isWord(tokens[0], "MERGE")) return null; // see positionalMergeTarget
  const start = tokens.findIndex((t) => isWord(t, "INSERT") || isWord(t, "REPLACE"));
  if (start === -1) return null;
  let i = start + 1;
  const skip = new Set(["INTO", "IGNORE", "LOW_PRIORITY", "DELAYED", "HIGH_PRIORITY", "OVERWRITE", "TABLE"]);
  while (isWord(tokens[i]) && skip.has((tokens[i] as { value: string }).value)) i++;
  const target = targetAfter(tokens, i);
  if (!target) return null;
  i = targetEnd(tokens, i);
  const next = tokens[i];
  // Alias (Postgres `INSERT INTO t AS x (…)`) before the column list
  if (isWord(next, "AS")) i += 2;
  const after = tokens[i];
  const hasColumnList =
    isPunct(after, "(") && !isWord(tokens[i + 1], "SELECT") && !isWord(tokens[i + 1], "WITH");
  if (hasColumnList || isWord(after, "SET")) return null;
  return target;
}

/** `MERGE [INTO] t … INSERT ROW | INSERT VALUES (…)` writes every column positionally. */
export function positionalMergeTarget(tokens: Token[]): { schema?: string; table: string } | null {
  if (!isWord(tokens[0], "MERGE")) return null;
  const positional = tokens.some(
    (t, i) => isWord(t, "INSERT") && (isWord(tokens[i + 1], "ROW") || isWord(tokens[i + 1], "VALUES")),
  );
  if (!positional) return null;
  return targetAfter(tokens, 1);
}

/** Index just past a dotted name starting at `from`. */
function targetEnd(tokens: Token[], from: number): number {
  let i = from;
  for (;;) {
    const t = tokens[i];
    if (t?.kind !== "ident" && t?.kind !== "word") return i;
    i++;
    if (!isPunct(tokens[i], ".")) return i;
    i++;
  }
}

/** Dotted name (`a.b.c`, `` `p.d.t` ``) starting at `from`, skipping a leading INTO. */
function targetAfter(tokens: Token[], from: number): { schema?: string; table: string } | null {
  let i = from;
  if (isWord(tokens[i], "INTO")) i++;
  const parts: string[] = [];
  for (;;) {
    const t = tokens[i];
    if (t?.kind === "ident") parts.push(...t.value.split("."));
    else if (t?.kind === "word") parts.push(t.raw);
    else break;
    i++;
    if (!isPunct(tokens[i], ".")) break;
    i++;
  }
  if (parts.length === 0) return null;
  return {
    schema: parts.length > 1 ? parts.slice(0, -1).join(".") : undefined,
    table: parts[parts.length - 1]!,
  };
}

const MYSQL_METADATA_KEYWORDS = new Set(["SHOW", "DESCRIBE", "DESC", "EXPLAIN"]);

/** Engine-agnostic SQL checks: admin statements, hidden column names, catalog access. */
export function assertSqlPolicy(
  sql: string,
  engine: Engine,
  policy: Policy | null,
  statements: StatementInfo[],
  connection: string,
): void {
  if (!policy) return;
  if (statements.some((s) => s.class === "admin")) {
    throw new Error(
      `connection "${connection}" has a schema/column policy; admin statements (DDL, scripts, SET…) are disabled on it`,
    );
  }
  if (engine === "postgres" && statements.some((s) => s.keyword === "EXPLAIN")) {
    throw new Error("use sql_explain instead of EXPLAIN on a connection with a schema/column policy");
  }
  if (engine === "mysql" && statements.some((s) => MYSQL_METADATA_KEYWORDS.has(s.keyword))) {
    throw new Error(
      `${statements[0]!.keyword} is disabled on connection "${connection}" (schema/column policy); use schemas_list, tables_list, table_describe or sql_explain`,
    );
  }
  const tokens = splitStatements(sql, engine);
  const idents = tokens.flatMap(identifierTokens);
  for (const id of idents) {
    const rule = policy.rules.find(
      (r) => r.column.test(id) && (!r.table || idents.some((other) => r.table!.test(other))),
    );
    if (rule) {
      throw new Error(`"${id}" matches hidden column pattern "${rule.source}" on connection "${connection}"`);
    }
    if (policy.schemas && engine !== "postgres") {
      const u = id.toUpperCase();
      if (u === "INFORMATION_SCHEMA" || u === "PERFORMANCE_SCHEMA" || u === "MYSQL" || u === "SYS") {
        throw new Error(`${id} is outside the schema allowlist of connection "${connection}"`);
      }
    }
  }
  // Writes return no result columns to check, so `INSERT … SELECT *` could copy hidden data out.
  // (Postgres inspects the real plan instead.)
  if (
    policy.rules.length > 0 &&
    engine !== "postgres" &&
    statements.some((s) => s.class === "write") &&
    tokens.some(hasStarProjection)
  ) {
    throw new Error(
      `list columns explicitly: SELECT * inside a write is refused on connection "${connection}" (hidden columns)`,
    );
  }
}
