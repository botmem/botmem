ARG NODE_IMAGE=node:22.23.1-bookworm-slim@sha256:53ada149d435c38b14476cb57e4a7da73c15595aba79bd6971b547ceb6d018bf
ARG NGINX_IMAGE=nginxinc/nginx-unprivileged:1.31.1-alpine@sha256:cc300bd2e8776708a8c2c8686a74f06eadf221c5ce01e85d0e821955d7a730ab
ARG GOLANG_IMAGE=golang:1.26.5-alpine@sha256:0178a641fbb4858c5f1b48e34bdaabe0350a330a1b1149aabd498d0699ff5fb2
ARG ALPINE_IMAGE=alpine:3.23.3@sha256:25109184c71bdad752c8312a8623239686a9a2071e8825f20acb8f2198c3f659
ARG PGVECTOR_IMAGE=pgvector/pgvector:0.8.2-pg17-bookworm@sha256:feb68f4f15446397d8cac7f4fe48fe4586de83160d1fc48b46283312d1a33966

FROM ${NODE_IMAGE} AS node-builder
ARG VITE_BOTMEM_API_URL
ARG VITE_BOTMEM_PRICE_LABEL
ENV VITE_BOTMEM_API_URL=$VITE_BOTMEM_API_URL \
    VITE_BOTMEM_PRICE_LABEL=$VITE_BOTMEM_PRICE_LABEL
WORKDIR /workspace
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/migrator/package.json apps/migrator/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/cli/package.json packages/cli/package.json
COPY packages/connector-domain/package.json packages/connector-domain/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/mcp/package.json packages/mcp/package.json
COPY packages/sdk/package.json packages/sdk/package.json
COPY packages/search-domain/package.json packages/search-domain/package.json
COPY packages/testkit/package.json packages/testkit/package.json
RUN pnpm install --frozen-lockfile
COPY apps apps
COPY packages packages
RUN pnpm build \
 && pnpm --filter @botmem-v2/api deploy --prod /opt/botmem-api \
 && pnpm --filter @botmem-v2/migrator deploy --prod /opt/botmem-migrator \
 && test -f /opt/botmem-api/dist/bin/api.js \
 && test -f /opt/botmem-api/dist/bin/sync-worker.js \
 && test -f /opt/botmem-api/dist/bin/projection-worker.js \
 && test -f /opt/botmem-api/dist/bin/commerce-reconciler.js \
 && test -f /opt/botmem-api/dist/bin/lifecycle-worker.js \
 && test -f /opt/botmem-migrator/dist/bin.js \
 && test -f /workspace/apps/web/dist/index.html

FROM ${NODE_IMAGE} AS node-runtime
ARG BUILD_VERSION=0.0.0-unreleased
ARG VCS_REF=unknown
LABEL org.opencontainers.image.title="Botmem v2" \
      org.opencontainers.image.version="${BUILD_VERSION}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.source="https://github.com/botmem/botmem" \
      org.opencontainers.image.licenses="AGPL-3.0-only"
ENV NODE_ENV=production \
    NODE_OPTIONS="--enable-source-maps --disable-proto=throw"
# Package managers are build-time tools. Keeping npm/corepack in the runtime
# image adds executable surface and vulnerabilities that the services never use.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /opt/yarn-v1.22.22 \
 && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
          /usr/local/bin/pnpm /usr/local/bin/pnpx /usr/local/bin/yarn \
          /usr/local/bin/yarnpkg
WORKDIR /app
COPY --from=node-builder --chown=1000:1000 /opt/botmem-api/ ./
COPY --chmod=0555 deploy/docker/run-with-secret-files.sh /usr/local/bin/botmem-run-with-secret-files
USER 1000:1000
ENTRYPOINT ["/usr/local/bin/botmem-run-with-secret-files"]

FROM node-runtime AS api
EXPOSE 12412
CMD ["node", "dist/bin/api.js"]

FROM node-runtime AS sync-worker
CMD ["node", "dist/bin/sync-worker.js"]

FROM node-runtime AS projection-worker
CMD ["node", "dist/bin/projection-worker.js"]

FROM node-runtime AS commerce-reconciler
CMD ["node", "dist/bin/commerce-reconciler.js"]

FROM node-runtime AS lifecycle-worker
CMD ["node", "dist/bin/lifecycle-worker.js"]

FROM ${NGINX_IMAGE} AS web
ARG BUILD_VERSION=0.0.0-unreleased
ARG VCS_REF=unknown
LABEL org.opencontainers.image.title="Botmem v2 Web" \
      org.opencontainers.image.version="${BUILD_VERSION}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.source="https://github.com/botmem/botmem" \
      org.opencontainers.image.licenses="AGPL-3.0-only"
USER 0
RUN apk upgrade --no-cache
COPY deploy/docker/nginx.conf /etc/nginx/nginx.conf
COPY --from=node-builder /workspace/apps/web/dist/ /usr/share/nginx/html/
USER 101:101
EXPOSE 8080

FROM ${NODE_IMAGE} AS migrator
ARG BUILD_VERSION=0.0.0-unreleased
ARG VCS_REF=unknown
LABEL org.opencontainers.image.title="Botmem v2 Database Migrator" \
      org.opencontainers.image.version="${BUILD_VERSION}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.source="https://github.com/botmem/botmem" \
      org.opencontainers.image.licenses="AGPL-3.0-only"
ENV NODE_ENV=production \
    NODE_OPTIONS="--enable-source-maps --disable-proto=throw"
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /opt/yarn-v1.22.22 \
 && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
          /usr/local/bin/pnpm /usr/local/bin/pnpx /usr/local/bin/yarn \
          /usr/local/bin/yarnpkg
WORKDIR /app
COPY --from=node-builder --chown=1000:1000 /opt/botmem-migrator/ ./
COPY --chown=1000:1000 db/migration/ /app/migrations/
COPY --chmod=0555 deploy/docker/run-with-secret-files.sh /usr/local/bin/botmem-run-with-secret-files
USER 1000:1000
ENTRYPOINT ["/usr/local/bin/botmem-run-with-secret-files"]
CMD ["node", "dist/bin.js"]

# The upstream pgvector image includes a gosu binary built with an obsolete Go
# toolchain. Rebuild that tiny privilege-drop helper with a patched toolchain,
# and install all currently available Debian security updates into the runtime.
FROM ${GOLANG_IMAGE} AS gosu-builder
ARG GOSU_VERSION=1.19
RUN CGO_ENABLED=0 go install -trimpath -ldflags="-s -w" \
      "github.com/tianon/gosu@${GOSU_VERSION}" \
 && test "$(/go/bin/gosu --version | awk '{print $1}')" = "${GOSU_VERSION}"

FROM ${PGVECTOR_IMAGE} AS database
ARG BUILD_VERSION=0.0.0-unreleased
ARG VCS_REF=unknown
LABEL org.opencontainers.image.title="Botmem v2 PostgreSQL and pgvector" \
      org.opencontainers.image.version="${BUILD_VERSION}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.source="https://github.com/botmem/botmem" \
      org.opencontainers.image.licenses="PostgreSQL AND GPL-3.0-only"
USER 0
RUN apt-get update \
 && apt-get upgrade --yes \
 && rm -rf /var/lib/apt/lists/*
COPY --from=gosu-builder --chmod=0755 /go/bin/gosu /usr/local/bin/gosu
RUN gosu --version \
 && gosu nobody true

# Build stock Caddy from its immutable release tag with the patched Go
# toolchain. The production image contains no compiler or package manager data.
FROM ${GOLANG_IMAGE} AS caddy-builder
ARG CADDY_VERSION=v2.11.4
RUN CGO_ENABLED=0 go install -trimpath \
      -ldflags="-s -w -X github.com/caddyserver/caddy/v2.CustomVersion=${CADDY_VERSION}" \
      "github.com/caddyserver/caddy/v2/cmd/caddy@${CADDY_VERSION}" \
 && test "$(/go/bin/caddy version)" = "${CADDY_VERSION}"

FROM ${ALPINE_IMAGE} AS edge
ARG BUILD_VERSION=0.0.0-unreleased
ARG VCS_REF=unknown
LABEL org.opencontainers.image.title="Botmem v2 Caddy Edge" \
      org.opencontainers.image.version="${BUILD_VERSION}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.source="https://github.com/botmem/botmem" \
      org.opencontainers.image.licenses="Apache-2.0"
RUN apk upgrade --no-cache \
 && apk add --no-cache ca-certificates tzdata \
 && addgroup -S -g 1000 caddy \
 && adduser -S -D -H -u 1000 -G caddy caddy \
 && install -d -m 0750 -o caddy -g caddy /config /data /etc/caddy
COPY --from=caddy-builder --chmod=0755 /go/bin/caddy /usr/bin/caddy
ENV XDG_CONFIG_HOME=/config \
    XDG_DATA_HOME=/data
USER 1000:1000
WORKDIR /srv
EXPOSE 80 443 443/udp 2019
STOPSIGNAL SIGQUIT
ENTRYPOINT ["caddy"]
CMD ["run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
