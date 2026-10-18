import {
  identifierTokens,
  qualifierTokens,
  splitStatements,
  type StatementInfo,
  type Token,
} from "./sql/classify.js";
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
  /** BigQuery: project that unqualified datasets belong to. */
  project?: string;
  /** MySQL: compare schema names case-insensitively (server lower_case_table_names ≠ 0). */
  foldCase?: boolean;
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
  return {
    engine: connection.engine,
    schemas,
    rules,
    project: connection.engine === "bigquery" ? connection.projectId : undefined,
  };
}

/**
 * Engine semantics: Postgres schema names are exact (quoted "SHOP" ≠ shop); MySQL is exact
 * unless the server folds case; BigQuery compares fully qualified project.dataset names,
 * unqualified ones belonging to the connection's project.
 */
export function schemaAllowed(policy: Policy | null, schema: string | null | undefined): boolean {
  if (!policy?.schemas || schema === null || schema === undefined) return true;
  if (policy.engine === "postgres") return policy.schemas.includes(schema);
  if (policy.engine === "mysql") {
    return policy.foldCase
      ? policy.schemas.some((a) => a.toLowerCase() === schema.toLowerCase())
      : policy.schemas.includes(schema);
  }
  const qualify = (name: string) => (name.includes(".") ? name : `${policy.project ?? ""}.${name}`);
  return policy.schemas.some((allowed) => qualify(allowed) === qualify(schema));
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
/** Every `INSERT/REPLACE [INTO] t VALUES|SELECT …` without a column list (CTEs included). */
export function positionalInsertTargets(tokens: Token[]): Array<{ schema?: string; table: string }> {
  if (isWord(tokens[0], "MERGE")) return []; // see positionalMergeTarget
  const out: Array<{ schema?: string; table: string }> = [];
  tokens.forEach((t, start) => {
    if (!isWord(t, "INSERT") && !isWord(t, "REPLACE")) return;
    let i = start + 1;
    const skip = new Set([
      "INTO",
      "IGNORE",
      "LOW_PRIORITY",
      "DELAYED",
      "HIGH_PRIORITY",
      "OVERWRITE",
      "TABLE",
    ]);
    while (isWord(tokens[i]) && skip.has((tokens[i] as { value: string }).value)) i++;
    const target = targetAfter(tokens, i);
    if (!target) return;
    i = targetEnd(tokens, i);
    // Alias (Postgres `INSERT INTO t AS x (…)`) before the column list
    if (isWord(tokens[i], "AS")) i += 2;
    const after = tokens[i];
    // `()` is MySQL's "all defaults" form: still writes every column.
    const hasColumnList =
      isPunct(after, "(") &&
      !isWord(tokens[i + 1], "SELECT") &&
      !isWord(tokens[i + 1], "WITH") &&
      !isPunct(tokens[i + 1], ")");
    if (hasColumnList || isWord(after, "SET")) return;
    out.push(target);
  });
  return out;
}

/** First positional INSERT/REPLACE target, if any. */
export function positionalInsertTarget(tokens: Token[]): { schema?: string; table: string } | null {
  return positionalInsertTargets(tokens)[0] ?? null;
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

/** Table names in the statement with their qualifier (`s.t` → {s, t}; bare `t` → {t}). */
function tableRefs(tokens: Token[]): Array<{ qualifier?: string; name: string }> {
  const out: Array<{ qualifier?: string; name: string }> = [];
  tokens.forEach((t, i) => {
    if (t.kind === "ident" && t.value.includes(".")) {
      const parts = t.value.split(".");
      out.push({ qualifier: parts[parts.length - 2], name: parts[parts.length - 1]! });
      return;
    }
    if (t.kind !== "word" && t.kind !== "ident") return;
    const name = t.kind === "word" ? t.raw : t.value;
    const prev = tokens[i - 2];
    const qualifier =
      isPunct(tokens[i - 1], ".") && (prev?.kind === "word" || prev?.kind === "ident")
        ? prev.kind === "word"
          ? prev.raw
          : prev.value.split(".").pop()
        : undefined;
    out.push({ qualifier, name });
  });
  return out;
}

/** A hidden rule applies when its column is named and its table (and schema, when qualified) match. */
function ruleApplies(rule: Rule, tokens: Token[], idents: string[]): string | null {
  const column = idents.find((id) => rule.column.test(id));
  if (!column) return null;
  if (!rule.table) return column;
  const hit = tableRefs(tokens).some(
    (r) =>
      rule.table!.test(r.name) &&
      (!rule.schema || r.qualifier === undefined || rule.schema.test(r.qualifier)),
  );
  return hit ? column : null;
}

const SYSTEM_SCHEMAS = new Set(["INFORMATION_SCHEMA", "PERFORMANCE_SCHEMA", "MYSQL", "SYS"]);

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
  for (const stmt of tokens) {
    const idents = identifierTokens(stmt);
    for (const rule of policy.rules) {
      const id = ruleApplies(rule, stmt, idents);
      if (id)
        throw new Error(
          `"${id}" matches hidden column pattern "${rule.source}" on connection "${connection}"`,
        );
    }
    if (policy.schemas && engine === "postgres") {
      // Qualified function calls (`secret.read_vault()`) are invisible to the plan's relation check.
      stmt.forEach((t, i) => {
        const fn = stmt[i + 2];
        if (
          (t.kind === "word" || t.kind === "ident") &&
          isPunct(stmt[i + 1], ".") &&
          (fn?.kind === "word" || fn?.kind === "ident") &&
          isPunct(stmt[i + 3], "(")
        ) {
          const schema = t.kind === "word" ? t.raw.toLowerCase() : t.value;
          if (schema !== "pg_catalog" && !schemaAllowed(policy, schema)) {
            throw new Error(
              `function in schema "${schema}" is outside the allowlist of connection "${connection}"`,
            );
          }
        }
      });
    }
    if (policy.schemas && engine !== "postgres") {
      // Catalog schemas only matter as qualifiers (`information_schema.tables`), not as column names.
      const system = qualifierTokens(stmt).find((q) => SYSTEM_SCHEMAS.has(q.toUpperCase()));
      if (system) throw new Error(`${system} is outside the schema allowlist of connection "${connection}"`);
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
