# db-mcp

[![CI](https://github.com/L92-Labs/db-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/L92-Labs/db-mcp/actions/workflows/ci.yml) [![Release](https://img.shields.io/github/v/release/L92-Labs/db-mcp)](https://github.com/L92-Labs/db-mcp/releases) [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

<!-- source: badges only for what the repo has. CI = .github/workflows/ci.yml; release = the GitHub release of tag v0.1.0; license = LICENSE -->
Database **MCP** server for L92 Labs: **Postgres**, **MySQL** and **BigQuery**. One tool surface, two runtimes:

<!-- source: the setup links point at the install sections. Entry, Auth and Good for are the previous table, moved up so it follows "two runtimes:". -->
| Runtime | Entry | Auth | Good for |
|---------|-------|------|----------|
| **Node**: [published image](#quick-start-published-image), [stdio](#node--stdio-claude-desktop-cursor-claude-code), [Docker (HTTP)](#docker-http) | stdio or Streamable HTTP | Bearer token for HTTP only. Stdio starts without a token. <!-- source: apps/node/src/index.ts:21-29 --> | Local MCP clients, Docker on any host |
| **Cloudflare Worker**: [Workers + Hyperdrive](#cloudflare-workers--hyperdrive) | `POST /mcp` | bearer token or **OAuth 2.1** | Hosted remote MCP (claude.ai, ChatGPT, Cursor…), Postgres/MySQL through **Hyperdrive** |

Start here: [published Docker image](#quick-start-published-image),
[releases and manual publishing](docs/releases.md),
[contributing](CONTRIBUTING.md), [security](SECURITY.md), [changelog](CHANGELOG.md).

## Quick start: published image

Requires Docker Compose v2. Images become available after the first successful
publish; anonymous pulls require the GHCR package to be public.

<!-- source: .env.example; docker-compose.image.yml; .github/workflows/ci.yml:71-78 (bounded health polling) -->
```bash
git clone https://github.com/L92-Labs/db-mcp.git
cd db-mcp
cp .env.example .env
# Edit .env: real DB connection + strong MCP_BEARER_TOKEN; keep DB_ACCESS=read_only.
# Generate a bearer token: openssl rand -hex 32
docker compose -f docker-compose.image.yml pull
docker compose -f docker-compose.image.yml up -d
(
  for attempt in {1..30}; do
    if curl --fail --silent --max-time 1 http://127.0.0.1:8787/health; then
      exit 0
    fi
    sleep 1
  done
  echo "db-mcp health check timed out" >&2
  exit 1
)
```

Connect a Streamable HTTP MCP client to `http://127.0.0.1:8787/mcp` with
`Authorization: Bearer <your-token>`. `/health` checks server/config
availability, not database access; call `connection_info` to verify the
connection.

> [!NOTE]
> The database host must be reachable from inside the container; `localhost` in a DB URL refers to the container itself.

Set `DB_MCP_IMAGE=ghcr.io/l92-labs/db-mcp:0.1.0` in `.env` to select a release,
or use `ghcr.io/l92-labs/db-mcp@sha256:<digest>` for a pinned image. Available
tags: stable `latest`, exact SemVer, and `sha-<full-commit>`. Main commits and
prereleases never advance `latest`.

For a Cloudflare Tunnel, set `TUNNEL_TOKEN`, configure the tunnel's public HTTPS
hostname to service `http://db-mcp:8787`, then run:

```bash
docker compose -f docker-compose.image.yml --profile tunnel up -d
```

Remote clients use `https://<your-hostname>/mcp` with the same bearer header.
Node/Docker uses bearer authentication; OAuth is implemented by the Worker.
Both Compose configurations bind the app to loopback and run it read-only as a
non-root user. The source Compose file also contains optional demo databases.

To update, change `DB_MCP_IMAGE` if pinned, then repeat `pull` and `up -d`.
To roll back, set the previous version/digest and repeat those commands.
Inspect status/logs with `docker compose -f docker-compose.image.yml ps` and
`docker compose -f docker-compose.image.yml logs --tail=100 db-mcp`.

## Node / stdio (Claude Desktop, Cursor, Claude Code)

<!-- source: CONTRIBUTING.md ("Use Node 22 and the pnpm version pinned in package.json"); package.json:10 -->
Needs Node 22 and the pnpm version pinned in `package.json` ([CONTRIBUTING.md](CONTRIBUTING.md)).

<!-- source: commands from CONTRIBUTING.md -->
```bash
corepack enable
pnpm install --frozen-lockfile
pnpm run build
cp .env.example .env
```

<!-- source: apps/node/src/index.ts:8-12; packages/core/src/config.ts:243-247; .env.example:36-59 -->
Before launching the client, edit `.env` in the repository root. Configure a
reachable Postgres or MySQL URL, [BigQuery](#bigquery-setup), or
`DB_CONNECTIONS_JSON`. Remove or comment out unused sample URLs. Use the
absolute checkout paths in the client configuration below.

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

<!-- source: docker-compose.yml:2; source: apps/node/src/server.ts:56; source: .env.example:36-50; source: packages/core/src/config.ts:258-259; source: scripts/smoke.mjs:7,25-37; source: package.json:8; source: package.json:18; source: CONTRIBUTING.md:3 -->
From the repository root, use Docker Compose v2, Node 22 and the pnpm version
pinned in `package.json`. Edit `.env` as indicated before starting Compose.

```bash
cp .env.example .env
# Edit .env and set MCP_BEARER_TOKEN plus DATABASE_URL, MYSQL_URL or BigQuery settings.
# Remove or comment out unused sample URLs. Unnamed smoke calls use the default connection.
docker compose up --build -d
```

<!-- source: docker-compose.yml:6; source: scripts/smoke.mjs:7 -->
Compose loads the token into the container. The smoke command loads the token
from `.env` for the host Node process.

<!-- source: docker-compose.yml:6; source: docker-compose.yml:16 -->
For demo databases with a seeded `shop` schema, set these values in `.env`
before startup. Compose supplies them to the container when it starts.

```dotenv
DATABASE_URL=postgres://postgres:postgres@postgres:5432/postgres
MYSQL_URL=mysql://root:root@mysql:3306/shop
```

<!-- source: .github/workflows/ci.yml:20-38,50-56; docker-compose.yml:17-36; examples/seed.sql:44-47; examples/seed.mysql.sql:39-41 -->
For the demo, replace the startup command with the block below. It waits for
TCP connections to both databases and checks for the final fixture inserted
by each seed script. Continue to the health check only when this block succeeds.

```bash
(
  set -e -o pipefail
  docker compose --profile demo up --build -d

  for attempt in {1..30}; do
    if docker compose exec -T postgres psql -h 127.0.0.1 -U postgres -d postgres \
        -Atc 'SELECT id FROM secret.vault WHERE id = 1' | grep -qx 1 &&
      docker compose exec -T mysql mysql -h 127.0.0.1 -uroot -proot -N \
        -e 'SELECT id FROM secret.vault WHERE id = 1' | grep -qx 1; then
      exit 0
    fi
    sleep 1
  done

  echo 'Demo databases did not become ready with seed data.' >&2
  exit 1
)
```

<!-- source: apps/node/src/server.ts:56-65; scripts/smoke.mjs:25-38 -->
After startup and any demo readiness checks, run the HTTP health check and
smoke test. Check the smoke output for database errors.

```bash
curl --fail --retry 10 --retry-connrefused http://127.0.0.1:8787/health &&
  corepack pnpm install --frozen-lockfile &&
  env -u MCP_BEARER_TOKEN node --env-file=.env scripts/smoke.mjs http://127.0.0.1:8787/mcp
```

Local MCP clients connect to `http://127.0.0.1:8787/mcp` with the header
`Authorization: Bearer <MCP_BEARER_TOKEN>`. Remote access requires an HTTPS reverse
proxy (Caddy, Cloudflare Tunnel). Demo database ports also bind only to loopback.

## Cloudflare Workers + Hyperdrive

<!-- source: apps/worker/wrangler.toml:27; source: apps/worker/src/index.ts:90 -->
For `AUTH_MODE=bearer`, remove the entire `[[kv_namespaces]]` entry for
`OAUTH_KV` from `apps/worker/wrangler.toml` before running Wrangler. For
`AUTH_MODE=oauth`, run `npx wrangler kv namespace create OAUTH_KV` from
`apps/worker` and replace the placeholder ID in that entry with the namespace ID.

<!-- source: apps/worker/wrangler.toml:11-25,33-43; packages/core/src/config.ts:201-209 -->
Run `pnpm install` at the repository root, then `cd apps/worker`. Choose a
database setup before deploying:

- **Postgres**. Run `npx wrangler hyperdrive create db-mcp-main --connection-string="postgres://user:pw@host:5432/db"` with your connection string. Set the returned ID on the `HYPERDRIVE` entry in `wrangler.toml`.
- **MySQL only**. Run `npx wrangler hyperdrive create db-mcp-mysql --connection-string="mysql://user:pw@host:3306/db"` with your connection string. Uncomment the MySQL `[[hyperdrive]]` entry in `wrangler.toml`, set its ID to the returned ID, remove the entire Postgres `HYPERDRIVE` entry, and add `MYSQL_HYPERDRIVE = "HYPERDRIVE_MYSQL"` under `[vars]`. Leave `MYSQL_URL` unset to use the binding.

<!-- source: apps/worker/package.json:8 -->
For bearer mode, run:

```bash
npx wrangler secret put MCP_BEARER_TOKEN
pnpm run deploy
```

<!-- source: apps/worker/package.json:7; source: apps/worker/wrangler.toml:17 -->
For local development, run `pnpm run dev` separately from `apps/worker`. It uses
`localConnectionString` or `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_<BINDING>`.

If `DB_CONNECTIONS_JSON` and `DATABASE_URL` are both unset, the `HYPERDRIVE` binding becomes the connection `postgres`. For more databases, add more `[[hyperdrive]]` bindings and reference them by name: `{"engine":"mysql","hyperdrive":"HYPERDRIVE_MYSQL"}`, or set `MYSQL_HYPERDRIVE=HYPERDRIVE_MYSQL`. BigQuery works on Workers too: set `BIGQUERY_*` (or JSON) as secrets.

The Worker opens one database client per operation; Hyperdrive does the pooling. Hyperdrive caches read results by default (about 60 s). If an agent writes and then reads right away, create the config with `--caching-disabled` (or tune `--max-age`).

### OAuth (claude.ai and other remote MCP clients)

<!-- source: apps/worker/wrangler.toml:27-46; apps/worker/src/index.ts:95-98; apps/worker/src/oauth.ts:113-129; apps/worker/package.json:8; https://developers.cloudflare.com/workers/configuration/secrets/; https://developers.cloudflare.com/workers/wrangler/commands/workers/ -->
Before deploying OAuth, restore the `OAUTH_KV` entry if you removed it and
configure its namespace ID as above. In `apps/worker/wrangler.toml`, set
`AUTH_MODE = "oauth"` under `[vars]`. Put the chosen sign-in settings below
in a private dotenv file. From `apps/worker`, deploy with
`pnpm run deploy --secrets-file /absolute/path/to/oauth-secrets.env` to upload
the settings as Worker secrets with the new mode. Wrangler uses `.dev.vars`
for local development.

The Worker becomes an OAuth 2.1 authorization server (via `@cloudflare/workers-oauth-provider`):

- discovery (RFC 9728 / 8414), dynamic client registration and Client ID Metadata Documents
- PKCE, a consent page and refresh tokens

If configured, the static `MCP_BEARER_TOKEN` keeps working for CLI clients.

| Sign-in | Secrets |
|---------|---------|
| GitHub (recommended) | `OAUTH_LOGIN=github`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `OAUTH_ALLOWED_USERS=login1,login2`. Create a GitHub OAuth app with callback `https://<worker>/oauth/github/callback` |
| Password | `OAUTH_LOGIN=password`, `OAUTH_PASSWORD` (16+ chars) |

Scopes: `db:read` (always granted) and `db:write`, which the user can tick on the consent page. A token without `db:write` sees every connection as `read_only`, so `sql_execute` disappears. In claude.ai: Settings → Connectors → Add custom connector → `https://<worker>/mcp`.

## Configure

Copy [`.env.example`](.env.example) to `.env` (Node/Docker), or [`apps/worker/.dev.vars.example`](apps/worker/.dev.vars.example) to `apps/worker/.dev.vars`.

```bash
# simplest: one database, read-only
DATABASE_URL=postgres://readonly:pw@db:5432/app     # or MYSQL_URL=mysql://…
DB_ACCESS=read_only
MCP_BEARER_TOKEN=long-random-string

# several named connections
DB_CONNECTIONS_JSON='{
  "app":       {"engine":"postgres","url":"postgres://…","access":"read_write","description":"main app",
                "schemas":["public"],"hidden_columns":["users.password_hash","*token*"]},
  "legacy":    {"engine":"mysql","url":"mysql://…","ssl":"require"},
  "warehouse": {"engine":"bigquery","project_id":"my-proj","location":"EU",
                "credentials_json":"<base64 or raw key JSON>","default_dataset":"analytics",
                "max_bytes_billed":"10000000000","schemas":["analytics"]}
}'
DB_DEFAULT_CONNECTION=app
```

A connection with both `url` and `hyperdrive` works everywhere: Workers use the Hyperdrive binding, Node/Docker use the url.

Environment settings. Where: `all` = every runtime, `Node` = Node and the Docker image, `Compose` = `docker-compose.image.yml`, `Workers` = the Worker only.

<!-- source: names and defaults from packages/core/src/config.ts; Node rows from apps/node/src/index.ts, apps/node/src/adapters.ts and the dotenv default path; Compose rows from docker-compose.image.yml; Worker rows from apps/worker/wrangler.toml, apps/worker/src/env.ts, apps/worker/src/index.ts and apps/worker/src/oauth.ts. -->
| Var | Default | Where | What it controls |
|-----|---------|-------|------------------|
| `MCP_BEARER_TOKEN` | none | all | Required for Node HTTP (including Docker) and Worker bearer mode. Optional in Worker OAuth mode <!-- source: apps/node/src/index.ts:21; source: apps/worker/src/index.ts:90 --> |
| `DB_ACCESS` | `read_only` | all | Default access level (`read_only`, `read_write`, `admin`; aliases `ro`, `rw`) |
| `DB_MAX_ROWS` / `DB_MAX_RESULT_BYTES` / `DB_MAX_CELL_CHARS` | `200` / `100000` / `2000` | all | Response budget |
| `DB_STATEMENT_TIMEOUT_MS` | `30000` | all | Per-statement timeout |
| `DB_AUDIT_LOG` | `meta` | all | `off`, `meta`, `sql` |
| `DB_HIDDEN_COLUMNS` | none | all | Hidden column globs for every connection |
| `DB_CONNECTIONS_JSON` | none | all | Several named connections; replaces the single-connection vars below |
| `DB_DEFAULT_CONNECTION` | first enumerated connection | all | Used when a tool call names none. Integer-like JSON keys (array indices) are enumerated in ascending numeric order before other keys <!-- source: packages/core/src/config.ts:174; source: packages/core/src/config.ts:258 --> |
| `DATABASE_URL` / `MYSQL_URL` / `BIGQUERY_PROJECT_ID` | none | all | One connection each for Postgres, MySQL and BigQuery, named `postgres`, `mysql`, `bigquery` |
| `DATABASE_SSL` / `MYSQL_SSL` | none | all | TLS for that connection: `require`, `no-verify`, `disable` |
| `DATABASE_ACCESS` / `MYSQL_ACCESS` / `BIGQUERY_ACCESS` | `DB_ACCESS` | all | Access level for that one connection |
| `DATABASE_SCHEMAS` / `MYSQL_SCHEMAS` / `BIGQUERY_DATASETS` | none | all | Schema or dataset allowlist for that one connection |
| `DATABASE_HIDDEN_COLUMNS` / `MYSQL_HIDDEN_COLUMNS` / `BIGQUERY_HIDDEN_COLUMNS` | none | all | Hidden columns for that one connection |
| `BIGQUERY_CREDENTIALS_JSON` / `BIGQUERY_ACCESS_TOKEN` | none | all | Service-account key (raw JSON or base64), or an access token for local tests |
| `BIGQUERY_LOCATION` / `BIGQUERY_DEFAULT_DATASET` / `BIGQUERY_MAX_BYTES_BILLED` | none | all | See [BigQuery setup](#bigquery-setup) |
| `DATABASE_HYPERDRIVE` | none | Workers | Binding name for shorthand `postgres`. `DATABASE_URL` takes precedence. When unset, an actual `HYPERDRIVE` binding overrides this name <!-- source: apps/worker/src/env.ts:29-34; packages/core/src/config.ts:184-192 --> |
| `MYSQL_HYPERDRIVE` | none | Workers | Binding name for shorthand `mysql`. `MYSQL_URL` takes precedence <!-- source: packages/core/src/config.ts:201-209 --> |
| `MCP_TRANSPORT` | `stdio` | Node | `stdio` or `http` (alias `streamable-http`); the Docker image sets `http` <!-- source: apps/node/src/index.ts:21; source: Dockerfile:17 --> |
| `PORT` | `8787` | Node | HTTP listen port |
| `DB_ENV_FILE` | `.env` in the working directory | Node | Path of the env file to load |
| `DB_POOL_MAX` | `5` | Node | Pool size per connection |
| `DB_MCP_IMAGE` | `ghcr.io/l92-labs/db-mcp:latest` | Compose | Image to pull: a tag, or `@sha256:<digest>` |
| `TUNNEL_TOKEN` | none | Compose | Cloudflare Tunnel token for `--profile tunnel` |
| `AUTH_MODE` | `bearer` | Workers | `bearer` or `oauth` |
| `OAUTH_LOGIN` | `password` (`github` when `GITHUB_CLIENT_ID` is set) | Workers | Sign-in method for OAuth: `github` or `password` |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | none | Workers | GitHub OAuth app used for sign-in |
| `OAUTH_ALLOWED_USERS` | none | Workers | Comma-separated GitHub logins allowed to sign in |
| `OAUTH_PASSWORD` | none | Workers | Sign-in password for `OAUTH_LOGIN=password`, 16+ chars |
| `HYPERDRIVE` (binding) | none | Workers | Postgres binding; becomes connection `postgres` when `DATABASE_URL` and `DB_CONNECTIONS_JSON` are unset |
| `HYPERDRIVE_MYSQL` (binding) | none | Workers | Optional MySQL binding, used through `MYSQL_HYPERDRIVE` or `"hyperdrive"` in `DB_CONNECTIONS_JSON` |
| `OAUTH_KV` (binding) | none | Workers | KV namespace; required when `AUTH_MODE=oauth` |

## BigQuery setup

1. Create a service account. For read-only, grant `roles/bigquery.dataViewer` + `roles/bigquery.jobUser`; for writes, add `roles/bigquery.dataEditor`.
2. Create a JSON key, then set it as `credentials_json` / `BIGQUERY_CREDENTIALS_JSON` (raw JSON or `base64 -w0 key.json`).
3. Set `location` (`US`, `EU`, `europe-west1`…) so jobs run in the right region and `columns_search` can use region-wide `INFORMATION_SCHEMA`.
4. Set `max_bytes_billed` to cap cost per query. Use `sql_explain` to see the bytes before running.

For quick local tests, `access_token` (`BIGQUERY_ACCESS_TOKEN`, e.g. from `gcloud auth print-access-token`) works in place of a key.

## Engines

Both runtimes share the same code. Postgres uses `pg` and MySQL uses `mysql2`; both run on Workers with `nodejs_compat`. BigQuery talks to the REST API with a service-account JWT signed by WebCrypto (no Google SDK).

<!-- source: BigQuery cells name the vars the shorthand connection reads (packages/core/src/config.ts); the other cells are unchanged. -->
| | Postgres | MySQL 8 (MariaDB: best effort, untested) | BigQuery |
|--|--|--|--|
| Node / Docker | `url` | `url` | `BIGQUERY_*` vars |
| Workers | Hyperdrive or `url` | Hyperdrive or `url` | `BIGQUERY_*` secrets |
| Read-only enforced by the engine | `BEGIN READ ONLY` | `START TRANSACTION READ ONLY` | dry-run `statementType` |
| `dry_run` writes | transaction + rollback | transaction + rollback (not DDL) | dry-run job (bytes, no row count) |

## Tools

| Tool | What it does |
|------|--------------|
| `connections_list` | Configured connections: engine, access level, policy, default |
| `connection_info` | Ping + server version, database/project, current user, read-only state |
| `schemas_list` | Schemas (Postgres), databases (MySQL), datasets (BigQuery) |
| `tables_list` | Tables and views (kind, estimated rows, size), filter by name |
| `table_describe` | Columns, types, nullability, defaults, comments, PK/FK, indexes, referencing tables, partitioning/clustering, view SQL |
| `table_sample` | First N rows, visible columns only. BigQuery uses `tabledata.list` for native tables with no bytes billed. Sampling views runs a query that can bill bytes. <!-- source: packages/core/src/bigquery/adapter.ts:457-484 --> |
| `columns_search` | Find columns by name across tables |
| `sql_query` | One **read-only** statement. Always read-only, whatever the connection allows |
| `sql_explain` | Plan without executing (Postgres `EXPLAIN (FORMAT JSON)`, MySQL `EXPLAIN FORMAT=JSON`); BigQuery dry run (bytes, statement type) <!-- source: packages/core/src/postgres/adapter.ts:638; source: packages/core/src/mysql/adapter.ts:844 --> |
| `sql_execute` | Writes up to the connection's access level. With `dry_run: true`, Postgres and MySQL preview supported writes in a transaction and roll back. BigQuery validates and estimates bytes without executing. **Only registered when some connection is not read-only** <!-- source: packages/core/src/bigquery/adapter.ts:263-292; packages/core/src/mysql/adapter.ts:805-819; Engines table above --> |

Bind parameters: Postgres `$1, $2…` from `params: [...]`; MySQL `?` from `params: [...]`; BigQuery `?` from `params: [...]` or `@name` from `params: {...}` (a value can be `{"type": "DATE", "value": "2024-01-01"}`).

## Access levels

Set `DB_ACCESS` for every connection, and override it per connection with `"access"` in `DB_CONNECTIONS_JSON` (or `DATABASE_ACCESS` / `MYSQL_ACCESS` / `BIGQUERY_ACCESS`).

| Access | Allows |
|--------|--------|
| `read_only` (default) | `SELECT`, `WITH`, `VALUES`, `TABLE`, `SHOW`, `EXPLAIN`, `DESCRIBE` |
| `read_write` | + `INSERT`, `UPDATE`, `DELETE`, `MERGE`, `REPLACE` (one statement per call, in a transaction) |
| `admin` | + DDL, `GRANT`, `VACUUM`, `CALL`; on Postgres also multi-statement scripts |

Each statement is checked twice:

1. **SQL classifier** (all engines). Comments, strings and dollar quotes are stripped; MySQL `/*! … */` executable comments are read as code. A call holds one statement (Postgres `admin` excepted). Data-modifying CTEs, `SELECT … INTO`, `EXPLAIN ANALYZE <write>` and side-effect functions are refused when access is too low (`pg_terminate_backend`, `set_config`, `dblink`, `LOAD_FILE`, `GET_LOCK`…).
2. **Engine enforcement**
   - **Postgres**: reads run in `BEGIN TRANSACTION READ ONLY` with `SET LOCAL statement_timeout`, through the extended protocol, which accepts one statement only. Rows stream through a cursor.
   - **MySQL**: reads run in `START TRANSACTION READ ONLY`. `sql_select_limit` sets the default server row limit. An explicit `LIMIT` can override it, and the adapter caps streamed rows separately. MySQL `max_execution_time` applies to `SELECT` only. MariaDB uses `max_statement_time`. <!-- source: packages/core/src/mysql/adapter.ts:125-140,165-177 --> `multipleStatements` is always off. MySQL DDL commits implicitly, so the classifier is what keeps DDL out.
   - **BigQuery**: every statement is dry-run first (free). Its `statementType` must fit the access level. `max_bytes_billed` caps cost.

For defense in depth, also use a **read-only database user** for read-only connections. For BigQuery, give the service account only `roles/bigquery.dataViewer` + `roles/bigquery.jobUser`.

## Guardrails: schema allowlist and hidden columns

Per connection: `"schemas": ["public", "shop"]` and `"hidden_columns": ["password", "users.ssn", "*token*"]`. Shorthand env vars: `DATABASE_SCHEMAS`, `MYSQL_SCHEMAS`, `BIGQUERY_DATASETS`, `*_HIDDEN_COLUMNS`. `DB_HIDDEN_COLUMNS` applies to every connection.

- **Metadata**: other schemas and hidden columns disappear from `schemas_list`, `tables_list`, `table_describe` and `columns_search`. `table_sample` selects only visible columns.
- **SQL**: any identifier matching a hidden pattern is refused. Then the engine checks what the statement really touches:
  - Postgres: `search_path` is pinned to the allowlist. `EXPLAIN (VERBOSE)` is inspected for every scanned relation and the columns read from it, which catches `SELECT *`, aliases and `row_to_json(t)`.
  - MySQL: schema-qualified names are checked against the server's schema list, and each result column's origin (`db`, `orgTable`, `orgName`) is checked before commit.
  - BigQuery: the dry run's referenced tables and output schema are checked.
- Admin statements are disabled on a connection that has a policy.

> [!IMPORTANT]
> Not a security boundary for SQL hidden inside functions or procedures: use database grants (column privileges, views) for hard guarantees.

## Response budget

<!-- source: packages/core/src/format.ts:65-104 -->
`DB_MAX_ROWS` (default 200) caps rows. `DB_MAX_RESULT_BYTES` (default 100 000) limits the serialized row array, and rows past it are dropped (`truncated_by: "bytes"`). Metadata and the result envelope add bytes. `DB_MAX_CELL_CHARS` (default 2 000) cuts long strings and JSON cells. All three keep agents from flooding their context.

## Audit log

<!-- source: packages/core/src/audit.ts:75-107 -->
`DB_AUDIT_LOG=meta` (default) writes one JSON line per tool call. Each line includes principal (`stdio`, `bearer`, `github:<login>`, `password`), tool, success status and duration. Connection and result fields such as statement class, command, rows, affected rows and the dry-run flag appear when available. Failed calls include an error. Calls with SQL text include `sql_sha256`. Use `sql` to include the SQL text, `off` to disable. Node writes to **stderr** (stdout carries stdio MCP). Workers write to Workers Logs (`[observability] enabled = true`).

## Layout

<!-- source: Dockerfile:1-23 (repository root) -->
```
packages/core   config, access levels, SQL classifier, policy, audit, tool schemas, dispatch, MCP server,
                postgres/ (pg + pg-cursor), mysql/ (mysql2), bigquery/ (REST + WebCrypto JWT)
apps/node       stdio + Streamable HTTP, pools per connection
apps/worker     /mcp on Workers, Hyperdrive bindings, OAuth 2.1 (GitHub / password sign-in)
Dockerfile      Node container image
examples/       seed.sql (Postgres) and seed.mysql.sql demo schemas
scripts/        smoke.mjs (bearer) and oauth-smoke.mjs (full OAuth flow) end-to-end checks
```

## Tests

<!-- source: .github/workflows/ci.yml:20-56; test/postgres.integration.test.ts:44-60; test/mysql.integration.test.ts:47-57 -->
```bash
pnpm test        # unit: classifier, config, policy, budget, audit, dispatch, MCP, BigQuery (mocked)

# Run from the repository root in Bash.
(
  set -e
  pg=
  mysql=
  trap 'docker stop ${pg:+"$pg"} ${mysql:+"$mysql"} >/dev/null 2>&1 || true' EXIT
  pg=$(docker run -d --rm -p 127.0.0.1:5432:5432 -e POSTGRES_PASSWORD=postgres postgres:17-alpine)
  mysql=$(docker run -d --rm -p 127.0.0.1:3306:3306 -e MYSQL_ROOT_PASSWORD=root -e MYSQL_DATABASE=shop mysql:8.4)

  wait_for_db() {
    for attempt in {1..30}; do
      if "$@" >/dev/null 2>&1; then return 0; fi
      sleep 1
    done
    echo "Database readiness timed out" >&2
    return 1
  }

  wait_for_db docker exec "$pg" pg_isready -h 127.0.0.1 -U postgres
  wait_for_db docker exec "$mysql" mysql -h 127.0.0.1 -uroot -proot -e 'SELECT 1'
  docker exec -i "$pg" psql -U postgres -d postgres -v ON_ERROR_STOP=1 < examples/seed.sql
  docker exec -i "$mysql" mysql -uroot -proot < examples/seed.mysql.sql

  TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres \
  TEST_MYSQL_URL=mysql://root:root@127.0.0.1:3306/shop pnpm test
)
```

<!-- source: scripts/oauth-smoke.mjs:2-7,42-43,118-125; apps/worker/src/oauth.ts:113-127; apps/worker/src/index.ts:35-38,95-98; apps/worker/.dev.vars.example:2-6; apps/worker/wrangler.toml:15-18,27-35; apps/worker/package.json:7; https://developers.cloudflare.com/kv/concepts/kv-bindings/ -->
For the OAuth smoke test, use Node 22 and install dependencies with `pnpm install`
at the repository root.

1. Keep or restore the `[[kv_namespaces]]` entry with `binding = "OAUTH_KV"` in
   `apps/worker/wrangler.toml`. Wrangler simulates the namespace locally.
   Start an isolated database and configure a reachable default connection
   using the local Hyperdrive settings above. For the sample Postgres binding,
   use a running local Postgres database at its `localConnectionString`.
2. Copy `apps/worker/.dev.vars.example` to `apps/worker/.dev.vars` if needed.
   In that file, set `AUTH_MODE=oauth`, `OAUTH_LOGIN=password` and
   `OAUTH_PASSWORD` to a value of at least 16 characters. Use `DB_ACCESS=read_only`
   for the read test below.
3. Run `pnpm run dev` from `apps/worker`. Once Wrangler listens on port 8787, open
   a second Bash shell at the repository root and enter the same password at
   the prompt.

<!-- source: apps/worker/src/oauth.ts:123-127; scripts/oauth-smoke.mjs:7 -->
```bash
IFS= read -r -s -p 'Worker OAuth password: ' OAUTH_PASSWORD
node scripts/oauth-smoke.mjs http://localhost:8787 "$OAUTH_PASSWORD" read
```

<!-- source: scripts/oauth-smoke.mjs:42-43,118-125; packages/core/src/dispatch.ts:39-43; packages/core/src/tools.ts:81 -->
To check write scope, configure at least one `read_write` or `admin` connection,
restart the Worker, and pass `write` as the final argument.

<!-- source: scripts/oauth-smoke.mjs:9-10,118-125 -->
For either scope, require a `PASS sql_query` line with a JSON result preview
from `SELECT 1 AS one`. A bare `PASS sql_query` can indicate a JSON-RPC error
with no result and does not count as success. Check for `FAIL` lines as well.

<!-- source: CONTRIBUTING.md -->
> [!CAUTION]
> The live tests run only when `TEST_DATABASE_URL` / `TEST_MYSQL_URL` are set, and they create, update and delete fixture data. Use isolated instances and never point them at a production database.

## License

MIT
