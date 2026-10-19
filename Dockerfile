FROM node:26-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/core/package.json packages/core/
COPY apps/node/package.json apps/node/
RUN pnpm install --frozen-lockfile --filter @db-mcp/node... --filter db-mcp
COPY tsconfig.base.json ./
COPY packages/core packages/core
COPY apps/node apps/node
RUN pnpm --filter @db-mcp/core build && pnpm --filter @db-mcp/node build \
  && pnpm --filter @db-mcp/node deploy --prod --legacy /out

FROM node:26-alpine
WORKDIR /app
ENV NODE_ENV=production \
    MCP_TRANSPORT=http \
    PORT=8787
COPY --from=build /out ./
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8787/health || exit 1
CMD ["node", "dist/index.js"]
