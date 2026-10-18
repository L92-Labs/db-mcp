# db-mcp

Database **MCP** server for L92 Labs: **Postgres** and **BigQuery**. One tool surface, two runtimes:

| Runtime | Entry | Good for |
|---------|-------|----------|
| **Node** | stdio or Streamable HTTP | Local MCP clients, Docker on any host |
| **Cloudflare Worker** | `POST /mcp` | Hosted remote MCP, Postgres through **Hyperdrive** |

Both runtimes share the same code: Postgres uses `pg` (works on Workers with `nodejs_compat`), and BigQuery talks to the REST API with a service-account JWT signed by WebCrypto (no Google SDK).

## Tools

| Tool | What it does |
|------|--------------|
| `connections_list` | Configured connections: engine, access level, default |
| `connection_info` | Ping + server version, database/project, current user, read-only state |
| `schemas_list` | Postgres schemas / BigQuery datasets |
| `tables_list` | Tables and views (kind, estimated rows, size), filter by name |
| `table_describe` | Columns, types, nullability, defaults, comments, PK/FK, indexes, referencing tables, partitioning/clustering, view SQL |
| `table_sample` | First N rows (BigQuery uses `tabledata.list`, which bills nothing) |
| `columns_search` | Find columns by name across tables |
| `sql_query` | One **read-only** statement. Always read-only, whatever the connection allows |
| `sql_explain` | Postgres `EXPLAIN (FORMAT JSON)` without executing; BigQuery dry run (bytes processed, statement type) |
| `sql_execute` | Writes, up to the connection's access level. **Only registered when some connection is not read-only** |

Bind parameters: Postgres `$1, $2…` from `params: [...]`; BigQuery `?` from `params: [...]` or `@name` from `params: {...}` (a value can be `{"type": "DATE", "value": "2024-01-01"}` to set the type).

## Access levels

Set `DB_ACCESS` for every connection, and override it per connection with `"access"` in `DB_CONNECTIONS_JSON` (or `DATABASE_ACCESS` / `BIGQUERY_ACCESS`).

| Access | Allows |
|--------|--------|
| `read_only` (default) | `SELECT`, `WITH`, `VALUES`, `TABLE`, `SHOW`, `EXPLAIN` |
| `read_write` | + `INSERT`, `UPDATE`, `DELETE`, `MERGE` (one statement per call, in a transaction) |
| `admin` | + DDL, `GRANT`, `VACUUM`, `CALL`, multi-statement scripts (autocommit) |

Each statement is checked twice:

1. **SQL classifier** (both engines). Comments, strings, quoted identifiers and dollar quotes are stripped. A call holds one statement unless the connection is `admin`. Data-modifying CTEs, `SELECT … INTO`, `EXPLAIN ANALYZE <write>` and side-effect functions (`pg_terminate_backend`, `set_config`, `dblink`, `lo_import`…) are refused when access is too low.
2. **Engine enforcement**
   - **Postgres**: reads run inside `BEGIN TRANSACTION READ ONLY` with `SET LOCAL statement_timeout`, using the extended protocol, which accepts a single statement only. So a write hidden in a function is still refused by the server. Rows stream through a cursor, so a huge result never loads into memory.
   - **BigQuery**: every statement is dry-run first (free). The `statementType` from the dry run must fit the access level before the job runs. `max_bytes_billed` caps cost.

For defense in depth, also connect read-only connections as a **read-only database role** (Postgres), or give the service account only `roles/bigquery.dataViewer` + `roles/bigquery.jobUser`.

## Configure

Copy [`.env.example`](.env.example) to `.env` (Node/Docker), or [`apps/worker/.dev.vars.example`](apps/worker/.dev.vars.example) to `apps/worker/.dev.vars`.

```bash
# simplest: one database, read-only
DATABASE_URL=postgres://readonly:pw@db:5432/app
DB_ACCESS=read_only
MCP_BEARER_TOKEN=long-random-string

# several named connections
DB_CONNECTIONS_JSON='{
  "app":       {"engine":"postgres","url":"postgres://…","access":"read_write","description":"main app"},
  "replica":   {"engine":"postgres","url":"postgres://…","ssl":"require"},
  "warehouse": {"engine":"bigquery","project_id":"my-proj","location":"EU",
                "credentials_json":"<base64 or raw key JSON>","default_dataset":"analytics",
                "max_bytes_billed":"10000000000"}
}'
DB_DEFAULT_CONNECTION=app
```

| Var | Default | |
|-----|---------|--|
| `DB_ACCESS` | `read_only` | default access level (`read_only`, `read_write`, `admin`; aliases `ro`, `rw`) |
| `DB_MAX_ROWS` | `200` | cap on returned rows (`truncated: true` when hit) |
| `DB_STATEMENT_TIMEOUT_MS` | `30000` | per-statement timeout |
| `MCP_BEARER_TOKEN` | — | required for HTTP / Docker / Workers |
| `DB_POOL_MAX` | `5` | Node: pg pool size per connection |

## Node / stdio (Claude Desktop, Cursor, Claude Code)

```bash
pnpm install
pnpm build
```

```json
{
  "mcpServers": {
    "db": {
      "command": "node",
      "args": ["/absolute/path/to/db-mcp/apps/node/dist/index.js"],
      "env": { "DB_ENV_FILE": "/absolute/path/to/db-mcp/.env", "MCP_TRANSPORT": "stdio" }
    }
  }
}
```

## Docker (HTTP)

```bash
cp .env.example .env              # set DATABASE_URL / BigQuery vars + MCP_BEARER_TOKEN
docker compose up --build
curl -s localhost:8787/health
node scripts/smoke.mjs http://localhost:8787/mcp "$MCP_BEARER_TOKEN"
```

Demo database with a seeded `shop` schema: `docker compose --profile demo up --build`, with `DATABASE_URL=postgres://postgres:postgres@postgres:5432/postgres`.

Remote MCP clients connect to `http://HOST:8787/mcp` with the header `Authorization: Bearer <MCP_BEARER_TOKEN>`.

## Cloudflare Workers + Hyperdrive

```bash
pnpm install
cd apps/worker
npx wrangler hyperdrive create db-mcp-main --connection-string="postgres://user:pw@host:5432/db"
# put the returned id in wrangler.toml ([[hyperdrive]] binding = "HYPERDRIVE")
cp .dev.vars.example .dev.vars
pnpm dev                       # local: uses localConnectionString (or CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE)
npx wrangler secret put MCP_BEARER_TOKEN
pnpm deploy
```

If `DB_CONNECTIONS_JSON` and `DATABASE_URL` are both unset, the `HYPERDRIVE` binding becomes the connection `postgres`. For more databases, add more `[[hyperdrive]]` bindings and reference them by name: `{"engine":"postgres","hyperdrive":"HYPERDRIVE_REPLICA"}`. BigQuery works on Workers too: set `BIGQUERY_*` (or JSON) as secrets.

The Worker opens one `pg.Client` per operation; Hyperdrive does the pooling. Hyperdrive caches read results by default (about 60 s). If an agent writes and then reads right away, create the config with `--caching-disabled` (or tune `--max-age`).

## BigQuery setup

1. Create a service account. For read-only, grant `roles/bigquery.dataViewer` + `roles/bigquery.jobUser`; for writes, add `roles/bigquery.dataEditor`.
2. Create a JSON key, then set it as `credentials_json` / `BIGQUERY_CREDENTIALS_JSON` (raw JSON or `base64 -w0 key.json`).
3. Set `location` (`US`, `EU`, `europe-west1`…) so jobs run in the right region and `columns_search` can use region-wide `INFORMATION_SCHEMA`.
4. Set `max_bytes_billed` to cap cost per query. Use `sql_explain` to see the bytes before running.

For quick local tests, `access_token` (`BIGQUERY_ACCESS_TOKEN`, e.g. from `gcloud auth print-access-token`) works in place of a key.

## Layout

```
packages/core   config, access levels, SQL classifier, tool schemas, dispatch, MCP server,
                postgres/ (pg + pg-cursor) and bigquery/ (REST + WebCrypto JWT) adapters
apps/node       stdio + Streamable HTTP, pg.Pool per connection, Dockerfile
apps/worker     /mcp on Workers, Hyperdrive bindings, pg.Client per operation
examples/       seed.sql demo schema
scripts/        smoke.mjs end-to-end MCP check
```

## Tests

```bash
pnpm test                                    # unit: classifier, config, dispatch, MCP, BigQuery (mocked)
docker run -d --rm -p 5432:5432 -e POSTGRES_PASSWORD=postgres \
  -v $PWD/examples/seed.sql:/docker-entrypoint-initdb.d/seed.sql:ro postgres:17-alpine
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres pnpm test   # + live Postgres
```

## License

MIT
