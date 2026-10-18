import type { AccessLevel, Engine, StatementClass } from "../types.js";

/**
 * Lightweight SQL lexer + classifier. Not a parser: it strips comments, strings and
 * quoted identifiers, splits on top-level `;`, and inspects keywords. It is the first
 * gate only — engines enforce access again (Postgres READ ONLY transactions,
 * BigQuery dry-run statementType).
 */

type Token = { kind: "word"; value: string } | { kind: "punct"; value: string } | { kind: "literal" };

const CLASS_RANK: Record<StatementClass, number> = { read: 0, write: 1, admin: 2 };

export function maxClass(a: StatementClass, b: StatementClass): StatementClass {
  return CLASS_RANK[a] >= CLASS_RANK[b] ? a : b;
}

export function classAllowed(cls: StatementClass, allow: StatementClass): boolean {
  return CLASS_RANK[cls] <= CLASS_RANK[allow];
}

export function accessToClass(access: AccessLevel): StatementClass {
  if (access === "admin") return "admin";
  if (access === "read_write") return "write";
  return "read";
}

function isWordStart(ch: string): boolean {
  return /[A-Za-z_\u0080-￿]/.test(ch);
}

function isWordChar(ch: string): boolean {
  return /[A-Za-z0-9_$\u0080-￿]/.test(ch);
}

/** Tokenize into statements (arrays of tokens). Throws on unterminated strings/comments. */
export function splitStatements(sql: string, engine: Engine): Token[][] {
  const statements: Token[][] = [];
  let current: Token[] = [];
  let i = 0;
  const n = sql.length;
  const bq = engine === "bigquery";

  const pushLiteral = () => current.push({ kind: "literal" });

  while (i < n) {
    const ch = sql[i]!;
    const next = sql[i + 1];

    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    // Line comments: -- (both), # (BigQuery)
    if ((ch === "-" && next === "-") || (bq && ch === "#")) {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? n : end + 1;
      continue;
    }

    // Block comments (Postgres nests them)
    if (ch === "/" && next === "*") {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (!bq && sql[i] === "/" && sql[i + 1] === "*") {
          depth++;
          i += 2;
        } else if (sql[i] === "*" && sql[i + 1] === "/") {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
      if (depth > 0) throw new Error("unterminated block comment");
      continue;
    }

    if (ch === ";") {
      if (current.length > 0) statements.push(current);
      current = [];
      i++;
      continue;
    }

    // Postgres dollar-quoted strings: $$…$$ or $tag$…$tag$ (not $1 params)
    if (!bq && ch === "$") {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        if (end === -1) throw new Error("unterminated dollar-quoted string");
        i = end + tag.length;
        pushLiteral();
        continue;
      }
    }

    // String / identifier prefixes: E'..' (pg), r'..' b'..' rb'..' (bq)
    if (isWordStart(ch)) {
      let j = i;
      while (j < n && isWordChar(sql[j]!)) j++;
      const word = sql.slice(i, j);
      const quote = sql[j];
      const lower = word.toLowerCase();
      if (quote === "'" && !bq && (lower === "e" || lower === "b" || lower === "x" || lower === "n")) {
        i = skipQuoted(sql, j, "'", lower === "e");
        pushLiteral();
        continue;
      }
      if ((quote === "'" || quote === '"') && bq && /^(r|b|rb|br)$/.test(lower)) {
        i = skipBigQueryString(sql, j);
        pushLiteral();
        continue;
      }
      current.push({ kind: "word", value: word.toUpperCase() });
      i = j;
      continue;
    }

    if (ch === "'") {
      i = bq ? skipBigQueryString(sql, i) : skipQuoted(sql, i, "'", false);
      pushLiteral();
      continue;
    }

    if (ch === '"') {
      // Postgres: quoted identifier. BigQuery: string literal.
      i = bq ? skipBigQueryString(sql, i) : skipQuoted(sql, i, '"', false);
      pushLiteral();
      continue;
    }

    if (bq && ch === "`") {
      i = skipQuoted(sql, i, "`", true);
      pushLiteral();
      continue;
    }

    current.push({ kind: "punct", value: ch });
    i++;
  }

  if (current.length > 0) statements.push(current);
  return statements;
}

/** Skip a quoted run starting at `start` (the opening quote). Doubled quotes escape. */
function skipQuoted(sql: string, start: number, quote: string, backslashEscapes: boolean): number {
  let i = start + 1;
  while (i < sql.length) {
    const ch = sql[i];
    if (backslashEscapes && ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === quote) {
      if (sql[i + 1] === quote) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i++;
  }
  throw new Error("unterminated quoted string or identifier");
}

/** BigQuery strings: '..', "..", '''..''', """..""" (prefixes r/b handled by caller). */
function skipBigQueryString(sql: string, start: number): number {
  const q = sql[start]!;
  const triple = sql.slice(start, start + 3) === q.repeat(3);
  const close = triple ? q.repeat(3) : q;
  let i = start + close.length;
  while (i < sql.length) {
    if (sql[i] === "\\") {
      // Even in raw strings a backslash keeps the next quote from closing the literal.
      i += 2;
      continue;
    }
    if (sql.startsWith(close, i)) return i + close.length;
    if (!triple && sql[i] === "\n") break;
    i++;
  }
  throw new Error("unterminated string literal");
}

const READ_STARTERS = new Set(["SELECT", "WITH", "VALUES", "TABLE", "SHOW", "FROM"]);
const WRITE_STARTERS = new Set(["INSERT", "UPDATE", "DELETE", "MERGE", "UPSERT", "REPLACE"]);
const DML_WORDS = new Set(["INSERT", "UPDATE", "DELETE", "MERGE"]);

/** Postgres functions with side effects that a READ ONLY transaction does not block. */
const PG_SIDE_EFFECT_FUNCTIONS = new Set([
  "PG_TERMINATE_BACKEND",
  "PG_CANCEL_BACKEND",
  "PG_RELOAD_CONF",
  "PG_ROTATE_LOGFILE",
  "PG_SWITCH_WAL",
  "PG_CREATE_RESTORE_POINT",
  "PG_PROMOTE",
  "PG_LOG_BACKEND_MEMORY_CONTEXTS",
  "PG_READ_FILE",
  "PG_READ_BINARY_FILE",
  "PG_LS_DIR",
  "PG_STAT_FILE",
  "LO_IMPORT",
  "LO_EXPORT",
  "DBLINK",
  "DBLINK_EXEC",
  "DBLINK_CONNECT",
  "DBLINK_SEND_QUERY",
  "PG_ADVISORY_LOCK",
  "PG_ADVISORY_XACT_LOCK",
  "PG_TRY_ADVISORY_LOCK",
  "PG_ADVISORY_LOCK_SHARED",
  "PG_NOTIFY",
  "SET_CONFIG",
  "PG_CREATE_LOGICAL_REPLICATION_SLOT",
  "PG_CREATE_PHYSICAL_REPLICATION_SLOT",
  "PG_DROP_REPLICATION_SLOT",
]);

export type StatementInfo = {
  class: StatementClass;
  keyword: string;
  reason?: string;
};

function isPunct(t: Token | undefined, value: string): boolean {
  return t?.kind === "punct" && t.value === value;
}

function words(tokens: Token[]): string[] {
  return tokens.flatMap((t) => (t.kind === "word" ? [t.value] : []));
}

function classifyTokens(tokens: Token[], engine: Engine): StatementInfo {
  let start = 0;
  while (isPunct(tokens[start], "(")) start++;
  const first = tokens[start];
  if (!first || first.kind !== "word") {
    return { class: "admin", keyword: "?", reason: "statement does not start with a keyword" };
  }
  const keyword = first.value;

  if (keyword === "EXPLAIN") {
    return classifyExplain(tokens.slice(start + 1), engine);
  }

  if (READ_STARTERS.has(keyword)) {
    const ws = words(tokens);
    const dml = ws.find((w) => DML_WORDS.has(w));
    if (dml) {
      return { class: "write", keyword, reason: `${keyword} contains ${dml}` };
    }
    if (keyword === "SELECT" && ws.includes("INTO") && engine === "postgres") {
      return { class: "admin", keyword, reason: "SELECT … INTO creates a table" };
    }
    if (engine === "postgres") {
      for (let i = 0; i < tokens.length - 1; i++) {
        const t = tokens[i]!;
        const nxt = tokens[i + 1]!;
        if (
          t.kind === "word" &&
          PG_SIDE_EFFECT_FUNCTIONS.has(t.value) &&
          nxt.kind === "punct" &&
          nxt.value === "("
        ) {
          return { class: "admin", keyword, reason: `calls side-effect function ${t.value.toLowerCase()}()` };
        }
      }
    }
    return { class: "read", keyword };
  }

  if (WRITE_STARTERS.has(keyword)) {
    return { class: "write", keyword };
  }

  // BigQuery read-only metadata statements
  if (engine === "bigquery" && (keyword === "DESCRIBE" || keyword === "DESC")) {
    return { class: "read", keyword };
  }

  return { class: "admin", keyword };
}

function classifyExplain(rest: Token[], engine: Engine): StatementInfo {
  let i = 0;
  let analyze = false;
  if (rest[0]?.kind === "punct" && rest[0].value === "(") {
    let depth = 0;
    for (; i < rest.length; i++) {
      const t = rest[i]!;
      if (t.kind === "punct" && t.value === "(") depth++;
      else if (t.kind === "punct" && t.value === ")") {
        depth--;
        if (depth === 0) {
          i++;
          break;
        }
      } else if (t.kind === "word" && (t.value === "ANALYZE" || t.value === "ANALYSE")) analyze = true;
    }
  } else {
    const opts = new Set(["ANALYZE", "ANALYSE", "VERBOSE"]);
    while (rest[i]?.kind === "word" && opts.has((rest[i] as { value: string }).value)) {
      const w = (rest[i] as { value: string }).value;
      if (w === "ANALYZE" || w === "ANALYSE") analyze = true;
      i++;
    }
  }
  const inner = rest.slice(i);
  if (inner.length === 0)
    return { class: "admin", keyword: "EXPLAIN", reason: "EXPLAIN without a statement" };
  const innerInfo = classifyTokens(inner, engine);
  if (!analyze) {
    // Plain EXPLAIN never executes the statement.
    return { class: "read", keyword: "EXPLAIN" };
  }
  return {
    class: innerInfo.class,
    keyword: "EXPLAIN",
    reason: innerInfo.class === "read" ? undefined : `EXPLAIN ANALYZE executes ${innerInfo.keyword}`,
  };
}

export type SqlClassification = {
  class: StatementClass;
  statements: StatementInfo[];
};

export function classifySql(sql: string, engine: Engine): SqlClassification {
  const stmts = splitStatements(sql, engine);
  if (stmts.length === 0) throw new Error("SQL is empty");
  const infos = stmts.map((t) => classifyTokens(t, engine));
  let cls: StatementClass = "read";
  for (const info of infos) cls = maxClass(cls, info.class);
  if (infos.length > 1) cls = maxClass(cls, "admin");
  return { class: cls, statements: infos };
}

const CLASS_HINT: Record<StatementClass, string> = {
  read: "read_only",
  write: "read_write",
  admin: "admin",
};

/** Throws a descriptive error when `sql` needs more than `allow`. */
export function assertSqlAllowed(
  sql: string,
  engine: Engine,
  allow: StatementClass,
  context: { connection: string; tool: string },
): SqlClassification {
  const result = classifySql(sql, engine);
  if (classAllowed(result.class, allow)) return result;

  if (result.statements.length > 1) {
    throw new Error(
      `multiple statements (${result.statements.length}) need admin access on connection "${context.connection}"; send one statement per call`,
    );
  }
  const info = result.statements[0]!;
  const why = info.reason ? ` (${info.reason})` : "";
  if (context.tool === "sql_query") {
    throw new Error(
      `${info.keyword} statement${why} is not read-only; sql_query only runs reads. Use sql_execute on a connection with ${CLASS_HINT[result.class]} access.`,
    );
  }
  throw new Error(
    `${info.keyword} statement${why} requires ${CLASS_HINT[result.class]} access; connection "${context.connection}" is ${CLASS_HINT[allow]}.`,
  );
}
