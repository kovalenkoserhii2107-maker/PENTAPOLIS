# Canonical Single-Image Production Build for PENTAPOLIS (Bun + Vite + SQLite WAL)
FROM oven/bun:1 AS base
WORKDIR /app

# Install workspace dependencies with frozen lockfile if present
COPY package.json bun.lock tsconfig.base.json ./
COPY packages/shared-sim/package.json ./packages/shared-sim/package.json
COPY apps/server/package.json ./apps/server/package.json
COPY apps/client/package.json ./apps/client/package.json
RUN bun install --frozen-lockfile

# Copy monorepo sources and build production SPA bundle (`apps/client/dist`)
COPY . .
RUN bun run --cwd apps/client build

# Ensure persistent SQLite WAL mount directory exists
RUN mkdir -p /data

ENV NODE_ENV=production
ENV PORT=3000
ENV PENTAPOLIS_DB_PATH=/data/pentapolis.sqlite

EXPOSE 3000

CMD ["bun", "run", "apps/server/src/index.ts"]
