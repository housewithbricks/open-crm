# ---- build ---------------------------------------------------------------
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY server/package.json server/
COPY web/package.json web/
RUN pnpm install --frozen-lockfile
COPY . .
# TanStack Start + Nitro bundle the UI, REST API and MCP server into one self-contained .output folder.
RUN pnpm --filter web build

# ---- runtime -------------------------------------------------------------
FROM node:22-alpine
ENV NODE_ENV=production PORT=8080 HOST=0.0.0.0
WORKDIR /app
COPY --from=build /app/web/.output ./.output
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD wget -qO- http://127.0.0.1:${PORT}/health || exit 1
CMD ["node", ".output/server/index.mjs"]
