# Container releases

Image: `ghcr.io/l92-labs/db-mcp`. Platforms: `linux/amd64`, `linux/arm64`.
CI and the manual fallback use the same publisher and tag policy.

| Trigger | Tags |
|---|---|
| Push to `main` / manual workflow on `main` | `sha-<full 40-character commit>` |
| Git tag `v0.1.0` matching root `package.json` | `sha-<commit>`, `0.1.0`, `latest` |
| Git tag `v0.2.0-rc.1` matching root `package.json` | `sha-<commit>`, `0.2.0-rc.1` |
| Older stable release backfill | SHA and version only; does not move `latest` |
| Pull request | Tests and local Docker build; no registry login or publishing |

`latest` follows the highest stable version among fetched Git tags. Fetch all tags
before a manual publish. CI publishing is serialized across refs. Avoid publishing
different releases concurrently from different machines or mixing a manual publish
with an active CI publish. Do not retag releases or rebuild historical tags routinely:
base images can change. Use `image@sha256:...` for an immutable deployment.
No floating major/minor aliases while the project is below 1.0. SemVer build
metadata (`+build`) is unsupported in image versions; the SHA tag identifies source.

## Release

1. Merge changes and CI workflow into `main`.
2. Update root `package.json` version and MCP server version strings in
   `packages/core/src/server.ts`. Workspace package
   versions are private implementation versions, not published npm releases.
3. Commit, review and merge. For the existing 0.1.0 code, no version bump is needed.
4. From a clean checkout:

```bash
git switch main
git pull --ff-only
git fetch origin --tags
pnpm install --frozen-lockfile
pnpm build && pnpm typecheck && pnpm test
git tag -a v0.1.0 -m 'db-mcp 0.1.0'
git push origin v0.1.0
```

CI runs Postgres/MySQL integration checks and Docker build, then publishes with the
repository's `GITHUB_TOKEN` (`packages: write`); no stored registry PAT is needed.
Create a GitHub release from the tag with change notes after publishing succeeds.

## Manual fallback (Actions billing/outage)

Requires Git, Node 22, Docker with Buildx, and registry access. Run the same
validation above plus the [real Postgres/MySQL tests](../README.md#tests) before
publishing. Those require isolated seeded databases and both `TEST_DATABASE_URL`
and `TEST_MYSQL_URL`; unset variables skip the live tests. BigQuery tests use
mocks. This path uses local compute and does not call GitHub Actions.

```bash
git fetch origin --tags
git checkout v0.1.0
# PAT classic: write:packages; authorize organization SSO if required.
# Supply interactively; never commit or put the token on the command line.
docker login ghcr.io -u YOUR_GITHUB_LOGIN
docker buildx create --name db-mcp-release --driver docker-container
docker buildx inspect db-mcp-release --bootstrap
# Confirm linux/amd64 and linux/arm64 are supported.
# Linux hosts without emulation: this installs host binfmt handlers (privileged).
# docker run --privileged --rm tonistiigi/binfmt --install arm64
BUILDX_BUILDER=db-mcp-release node scripts/publish-image.mjs --version 0.1.0         # inspect only
BUILDX_BUILDER=db-mcp-release node scripts/publish-image.mjs --version 0.1.0 --push  # build both + publish
docker buildx imagetools inspect ghcr.io/l92-labs/db-mcp:0.1.0
docker buildx rm db-mcp-release
docker logout ghcr.io
```

Omit `--version` to publish only the commit tag. The publisher rejects dirty trees,
invalid versions, package-version mismatches and release tags pointing elsewhere.
It never logs in or creates tags on your behalf. A rebuild may update the SHA tag's
digest; pin the digest when reproducibility matters.

## Public distribution

The repository already carries the MIT license. Before changing visibility,
review all Git history and tracked files for credentials and private content.
Enable private vulnerability reporting and protect `main` with required CI.
Set repository visibility to public when that review is complete.

GHCR packages start private, including when the repository is public. After the
first publish, open the organization's `db-mcp` package settings and set its
visibility to public separately. Verify anonymous pulls from an environment with
no GHCR login. If a manual publish created the package first, ensure the repository
has Actions write access in the package's **Manage Actions access** settings.

References: [Docker multi-platform CI](https://docs.docker.com/build/ci/github-actions/multi-platform/),
[GHCR authentication and visibility](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry).
