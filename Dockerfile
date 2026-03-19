# check=skip=SecretsUsedInArgOrEnv
FROM node:24-alpine AS base
RUN apk add --no-cache git python3 make g++
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/cli/package.json packages/cli/
COPY packages/connector-sdk/package.json packages/connector-sdk/
# Copy all connector package.json files (auto-discovers new connectors)
COPY packages/connectors/ /tmp/connectors-src/
RUN find /tmp/connectors-src -name 'package.json' -maxdepth 2 | while read f; do \
      dir="packages/connectors/$(dirname "${f#/tmp/connectors-src/}")"; \
      mkdir -p "$dir" && cp "$f" "$dir/"; \
    done && rm -rf /tmp/connectors-src
RUN echo "shamefully-hoist=true" > .npmrc && \
    pnpm install --frozen-lockfile 2>/dev/null || pnpm install

FROM deps AS build
COPY . .
ENV NODE_OPTIONS="--max-old-space-size=2048"
# Frontend build-time args — defaults are for self-hosted (local auth, no analytics).
# CI overrides these for the hosted version (firebase auth, PostHog, etc.).
# These are NOT secrets — they are public client-side config baked into the JS bundle.
ARG VITE_AUTH_PROVIDER=local
ARG VITE_POSTHOG_API_KEY=
ARG VITE_POSTHOG_HOST=
ARG VITE_FIREBASE_API_KEY=
ARG VITE_FIREBASE_AUTH_DOMAIN=
ARG VITE_FIREBASE_PROJECT_ID=
ARG VITE_FIREBASE_STORAGE_BUCKET=
ARG VITE_FIREBASE_MESSAGING_SENDER_ID=
ARG VITE_FIREBASE_APP_ID=
# Vite inlines VITE_* at build time from process.env, so we set ENV from ARG.
ENV VITE_AUTH_PROVIDER=$VITE_AUTH_PROVIDER \
    VITE_POSTHOG_API_KEY=$VITE_POSTHOG_API_KEY \
    VITE_POSTHOG_HOST=$VITE_POSTHOG_HOST \
    VITE_FIREBASE_API_KEY=$VITE_FIREBASE_API_KEY \
    VITE_FIREBASE_AUTH_DOMAIN=$VITE_FIREBASE_AUTH_DOMAIN \
    VITE_FIREBASE_PROJECT_ID=$VITE_FIREBASE_PROJECT_ID \
    VITE_FIREBASE_STORAGE_BUCKET=$VITE_FIREBASE_STORAGE_BUCKET \
    VITE_FIREBASE_MESSAGING_SENDER_ID=$VITE_FIREBASE_MESSAGING_SENDER_ID \
    VITE_FIREBASE_APP_ID=$VITE_FIREBASE_APP_ID
RUN pnpm --filter @botmem/shared run build && \
    pnpm --filter @botmem/connector-sdk run build && \
    pnpm --filter '@botmem/connector-*' run build && \
    pnpm --filter @botmem/web run build && \
    pnpm --filter @botmem/api run build

FROM base AS runtime
WORKDIR /app

# Copy only what's needed at runtime (not source, tests, or dev deps)
COPY --from=build /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml /app/.npmrc ./
COPY --from=build /app/apps/api/package.json apps/api/
COPY --from=build /app/apps/api/dist apps/api/dist/
COPY --from=build /app/apps/api/drizzle.config.ts apps/api/
COPY --from=build /app/apps/api/src/db apps/api/src/db/
COPY --from=build /app/apps/web/dist apps/web/dist/
COPY --from=build /app/packages/shared/package.json packages/shared/
COPY --from=build /app/packages/shared/dist packages/shared/dist/
COPY --from=build /app/packages/cli/package.json packages/cli/
COPY --from=build /app/packages/connector-sdk/package.json packages/connector-sdk/
COPY --from=build /app/packages/connector-sdk/dist packages/connector-sdk/dist/
# Copy all connector package.json + dist (auto-discovers new connectors)
COPY --from=build /app/packages/connectors/ /tmp/connectors-build/
RUN find /tmp/connectors-build -mindepth 1 -maxdepth 1 -type d | while read dir; do \
      name=$(basename "$dir"); \
      mkdir -p "packages/connectors/$name"; \
      cp "$dir/package.json" "packages/connectors/$name/" 2>/dev/null || true; \
      [ -d "$dir/dist" ] && cp -r "$dir/dist" "packages/connectors/$name/dist"; \
    done && rm -rf /tmp/connectors-build

# Install production deps only (ignore-scripts skips husky/prepare hooks)
RUN echo "shamefully-hoist=true" > .npmrc && \
    pnpm install --frozen-lockfile --prod --ignore-scripts 2>/dev/null || pnpm install --prod --ignore-scripts

RUN mkdir -p /data
EXPOSE 12412
ENV NODE_ENV=production
ENV PORT=12412
CMD ["node", "apps/api/dist/main.js"]
