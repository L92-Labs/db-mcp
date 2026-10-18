import { identifierTokens, splitStatements, type StatementInfo } from "./sql/classify.js";
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
  return { schemas, rules };
}

export function schemaAllowed(policy: Policy | null, schema: string | null | undefined): boolean {
  if (!policy?.schemas || schema === null || schema === undefined) return true;
  const s = schema.toLowerCase();
  // BigQuery: "project.dataset" or "dataset" both match a "dataset" / "project.dataset" entry
  return policy.schemas.some((allowed) => {
    const a = allowed.toLowerCase();
    return a === s || s.endsWith(`.${a}`) || a.endsWith(`.${s}`);
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
  const idents = splitStatements(sql, engine).flatMap(identifierTokens);
  for (const id of idents) {
    if (policy.rules.some((r) => r.column.test(id))) {
      throw new Error(`"${id}" matches a hidden column pattern on connection "${connection}"`);
    }
    if (policy.schemas && engine !== "postgres") {
      const u = id.toUpperCase();
      if (u === "INFORMATION_SCHEMA" || u === "PERFORMANCE_SCHEMA" || u === "MYSQL" || u === "SYS") {
        throw new Error(`${id} is outside the schema allowlist of connection "${connection}"`);
      }
    }
  }
}
