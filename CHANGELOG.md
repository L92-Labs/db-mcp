# Changelog

## Unreleased

- BigQuery `columns_search` returns the queried project on each row, so explicitly
  allowlisted cross-project datasets (`project.dataset`) keep their rows instead of
  collapsing onto the connection's default project.
- BigQuery dry-run output checks keep table-scoped hidden-column rules scoped:
  `users.email` no longer rejects `SELECT email FROM orders`; joins touching `users`
  are still refused.
- MySQL admin statements stream their result sets: `CALL` returns the first result
  set's rows with valid column metadata, everything drains to completion, and only
  `max_rows + 1` rows are retained (no unbounded buffering).
- MySQL audit entries sanitize driver errors in `meta` mode to a stable code
  (`database error 42601 …`); driver text can echo SQL fragments or bound values.
  `sql` mode keeps the message. db-mcp's own guardrail messages are unchanged.
- MySQL dry runs resolve the tables a statement actually writes (INSERT/REPLACE
  INTO, UPDATE list + JOINs, DELETE names + FROM/USING) before engine and trigger
  checks, so an unrelated same-named table in another schema no longer blocks a
  valid preview.
- MySQL dry-run inserts disclose AUTO_INCREMENT consumption
  (`rolled back, except auto-increment counters (…)`), matching the Postgres
  sequence note.

## 0.1.0 — 2026-10-19

- Expose Postgres, MySQL and BigQuery through typed MCP tools on Node/Docker or
  Cloudflare Workers, with optional Hyperdrive and Worker OAuth.
- Explore schemas/tables/columns, sample rows, query/explain SQL and optionally
  execute writes with transaction previews and per-connection access levels.
- Add schema/column policies, response budgets, timeouts and audit metadata.
- Publish Docker images for linux/amd64 and linux/arm64 with SemVer, full-commit
  SHA and stable latest tags; provide a manual publishing fallback.
- Validate builds, types, unit tests, real Postgres/MySQL integration and container
  MCP access before publishing. Document deployment, operations and releases.

Initial public release. BigQuery CI coverage uses mocks; MariaDB compatibility
remains best effort and untested.
