# ============================================================
# Stage 1: Base - Node + pnpm + turbo
# ============================================================
FROM node:22-alpine AS base

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
RUN pnpm add -g turbo@^2.4.0

# ============================================================
# Stage 2: Pruner - turbo prune for API-only workspace
# ============================================================
FROM base AS pruner

WORKDIR /app
COPY . .
RUN turbo prune @botmem/api --docker

# ============================================================
# Stage 3: Builder - Install all deps + build API
# ============================================================
FROM base AS builder

RUN apk add --no-cache python3 make g++

WORKDIR /app

# Copy .npmrc for shamefully-hoist
COPY .npmrc .npmrc

# Install all dependencies (cached layer based on lockfile)
# --ignore-scripts skips husky prepare hook (not available in Docker)
COPY --from=pruner /app/out/json/ .
RUN pnpm install --frozen-lockfile --ignore-scripts && \
    pnpm rebuild better-sqlite3 bcrypt

# Copy source and build
COPY --from=pruner /app/out/full/ .

# Copy root tsconfig that sub-packages extend
COPY --from=pruner /app/tsconfig.base.json ./tsconfig.base.json

RUN pnpm turbo build --filter=@botmem/api

# Prune to production dependencies only
RUN rm -rf node_modules && \
    pnpm install --frozen-lockfile --prod --ignore-scripts && \
    pnpm rebuild better-sqlite3 bcrypt

# ============================================================
# Stage 4: Runner - Minimal production image
# ============================================================
FROM node:22-alpine AS runner

WORKDIR /app

# Create non-root user
RUN addgroup --system --gid 1001 nestjs && \
    adduser --system --uid 1001 nestjs

# Copy the entire workspace with built output and prod-only deps
# This preserves workspace symlinks that resolve @botmem/* packages
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/pnpm-workspace.yaml ./pnpm-workspace.yaml

# Copy API built output
COPY --from=builder /app/apps/api/dist ./apps/api/dist
COPY --from=builder /app/apps/api/package.json ./apps/api/package.json

# Copy workspace package built outputs (runtime dependencies)
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=builder /app/packages/connector-sdk/dist ./packages/connector-sdk/dist
COPY --from=builder /app/packages/connector-sdk/package.json ./packages/connector-sdk/package.json

# Copy connector packages (built outputs + package.json for resolution)
COPY --from=builder /app/packages/connectors/ ./packages/connectors/

# Create data directory for SQLite
RUN mkdir -p /app/data && chown nestjs:nestjs /app/data

ENV NODE_ENV=production
ENV PORT=12412

USER nestjs

EXPOSE 12412

WORKDIR /app/apps/api
CMD ["node", "dist/main.js"]
