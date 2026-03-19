# check=skip=SecretsUsedInArgOrEnv
FROM node:24-alpine AS base
RUN apk add --no-cache git
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/cli/package.json packages/cli/
COPY packages/connector-sdk/package.json packages/connector-sdk/
COPY packages/connectors/gmail/package.json packages/connectors/gmail/
COPY packages/connectors/slack/package.json packages/connectors/slack/
COPY packages/connectors/whatsapp/package.json packages/connectors/whatsapp/
COPY packages/connectors/imessage/package.json packages/connectors/imessage/
COPY packages/connectors/photos-immich/package.json packages/connectors/photos-immich/
COPY packages/connectors/locations/package.json packages/connectors/locations/
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
    pnpm --filter @botmem/connector-gmail run build && \
    pnpm --filter @botmem/connector-slack run build && \
    pnpm --filter @botmem/connector-whatsapp run build && \
    pnpm --filter @botmem/connector-imessage run build && \
    pnpm --filter @botmem/connector-photos-immich run build && \
    pnpm --filter @botmem/connector-locations run build && \
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
COPY --from=build /app/packages/connectors/gmail/package.json packages/connectors/gmail/
COPY --from=build /app/packages/connectors/gmail/dist packages/connectors/gmail/dist/
COPY --from=build /app/packages/connectors/slack/package.json packages/connectors/slack/
COPY --from=build /app/packages/connectors/slack/dist packages/connectors/slack/dist/
COPY --from=build /app/packages/connectors/whatsapp/package.json packages/connectors/whatsapp/
COPY --from=build /app/packages/connectors/whatsapp/dist packages/connectors/whatsapp/dist/
COPY --from=build /app/packages/connectors/imessage/package.json packages/connectors/imessage/
COPY --from=build /app/packages/connectors/imessage/dist packages/connectors/imessage/dist/
COPY --from=build /app/packages/connectors/photos-immich/package.json packages/connectors/photos-immich/
COPY --from=build /app/packages/connectors/photos-immich/dist packages/connectors/photos-immich/dist/
COPY --from=build /app/packages/connectors/locations/package.json packages/connectors/locations/
COPY --from=build /app/packages/connectors/locations/dist packages/connectors/locations/dist/

# Install production deps only (ignore-scripts skips husky/prepare hooks)
RUN echo "shamefully-hoist=true" > .npmrc && \
    pnpm install --frozen-lockfile --prod --ignore-scripts 2>/dev/null || pnpm install --prod --ignore-scripts

RUN mkdir -p /data
EXPOSE 12412
ENV NODE_ENV=production
ENV PORT=12412
CMD ["sh", "-c", "cd /app/apps/api && npx drizzle-kit push --force && node dist/main.js"]
