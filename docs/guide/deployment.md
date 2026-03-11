# Production Deployment

This guide covers deploying Botmem to your own server.

## Architecture

A production Botmem deployment consists of:

```
                    Internet
                       |
                  +----+----+
                  |  Caddy  |  (reverse proxy, auto SSL)
                  +----+----+
                       |
                  +----+----+
                  |   API   |  (NestJS container)
                  +----+----+
                    /  |  \
        +----------+  |  +----------+
        | PostgreSQL|  |  |  Qdrant  |
        |   :5432   |  |  |  :6333   |
        +-----------+  |  +----------+
                  +----+----+
                  |  Redis  |
                  |  :6379  |
                  +---------+
```

## Docker Setup

### Dockerfile

The API is built as a single Docker image:

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY . .
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
RUN echo "shamefully-hoist=true" > .npmrc
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @botmem/shared build
RUN pnpm --filter @botmem/connector-sdk build
RUN pnpm --filter @botmem/connector-* build
RUN pnpm --filter api build
ENV NODE_OPTIONS=--max-old-space-size=2048
CMD ["node", "apps/api/dist/main.js"]
```

### Production Docker Compose

```yaml
services:
  api:
    build: .
    restart: unless-stopped
    env_file: .env.prod
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
      qdrant:
        condition: service_healthy

  postgres:
    image: postgres:17-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: botmem
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: botmem
    volumes:
      - postgres-data:/var/lib/postgresql/data
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U botmem -d botmem']
      interval: 5s
      timeout: 3s
      retries: 5

  redis:
    image: redis:7.4-alpine
    restart: unless-stopped
    command: redis-server --appendonly yes --appendfsync everysec
    volumes:
      - redis-data:/data
    healthcheck:
      test: ['CMD', 'redis-cli', 'ping']
      interval: 5s
      timeout: 3s
      retries: 5

  qdrant:
    image: qdrant/qdrant:v1.17.0
    restart: unless-stopped
    volumes:
      - qdrant-data:/qdrant/storage
    healthcheck:
      test: ['CMD-SHELL', "bash -c 'echo > /dev/tcp/localhost/6333'"]
      interval: 5s
      timeout: 3s
      retries: 5

  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    ports:
      - '80:80'
      - '443:443'
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile
      - caddy-data:/data
      - caddy-config:/config

volumes:
  postgres-data:
  redis-data:
  qdrant-data:
  caddy-data:
  caddy-config:
```

### Caddyfile

```
yourdomain.com {
    reverse_proxy api:12412
}
```

Caddy automatically provisions and renews SSL certificates via Let's Encrypt.

## Required Production Environment Variables

Create a `.env.prod` file:

```bash
# Required — must be changed from defaults
DATABASE_URL=postgresql://botmem:STRONG_PASSWORD@postgres:5432/botmem
APP_SECRET=generate-a-random-64-char-string
JWT_ACCESS_SECRET=generate-another-random-string
JWT_REFRESH_SECRET=generate-another-random-string
OAUTH_JWT_SECRET=generate-another-random-string

# URLs
FRONTEND_URL=https://yourdomain.com
BASE_URL=https://yourdomain.com

# Infrastructure (internal Docker network)
REDIS_URL=redis://redis:6379
QDRANT_URL=http://qdrant:6333

# AI Backend
AI_BACKEND=ollama
OLLAMA_BASE_URL=http://your-ollama-host:11434

# Production mode
NODE_ENV=production
```

::: danger Generate unique secrets
Never use the default secret values in production. The server will refuse to start if it detects default secrets in production mode.

Generate secrets with: `openssl rand -base64 48`
:::

## Deploy

```bash
# On your server
git clone https://github.com/botmem/botmem.git /opt/botmem
cd /opt/botmem
cp .env.example .env.prod   # Edit with your values
docker compose -f docker-compose.prod.yml up -d
```

## Health Check

Verify the deployment:

```bash
curl https://yourdomain.com/api/version
```

Should return:

```json
{
  "version": "1.2.0",
  "uptime": 3600
}
```

## CI/CD

The project includes a GitHub Actions workflow (`.github/workflows/deploy.yml`) that:

1. Runs lint and tests (quality gate)
2. Builds the Docker image and pushes to GHCR
3. SSHs into the production server and deploys the new image
4. Verifies the health check
5. Creates a GitHub release
6. Publishes the CLI to npm

## Maintenance

### Restart the API

```bash
docker compose -f docker-compose.prod.yml restart api
```

### View logs

```bash
docker compose -f docker-compose.prod.yml logs -f api
```

### Database backup

```bash
docker compose -f docker-compose.prod.yml exec postgres \
  pg_dump -U botmem botmem > backup.sql
```
