# Changelog

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
