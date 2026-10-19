# Contributing

Use Node 22 and the pnpm version pinned in `package.json`.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test
```

Database integration tests run only when `TEST_DATABASE_URL` / `TEST_MYSQL_URL`
are set. Use isolated Postgres 17 and MySQL 8.4 instances seeded from `examples/`;
see the README for setup. These tests create, update and delete fixture data.
Never point them at a production database.

CI runs the complete suite against both databases, then builds Docker and checks
authenticated MCP queries and read-only enforcement through the container.
BigQuery tests are mocked; live cloud credentials are not required by CI.

Open a pull request describing the problem, change and verification. Keep Node
and Worker contracts aligned. Never commit credentials, real query results or
customer data. Release instructions: [docs/releases.md](docs/releases.md).
