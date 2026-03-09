FROM node:22-alpine AS base
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
ARG VITE_POSTHOG_API_KEY
ARG VITE_POSTHOG_HOST=https://eu.i.posthog.com
ENV VITE_POSTHOG_API_KEY=$VITE_POSTHOG_API_KEY
ENV VITE_POSTHOG_HOST=$VITE_POSTHOG_HOST
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
WORKDIR /app/apps/api
COPY --from=build /app /app
RUN mkdir -p /data
EXPOSE 12412
ENV NODE_ENV=production
ENV PORT=12412
CMD ["node", "dist/main.js"]
