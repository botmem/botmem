# Self-Hosting Onboarding Audit

**Date:** 2026-03-21
**Perspective:** New user following only README + docs.botmem.xyz
**Verdict:** Docs are solid for the happy path, but a new user will hit ~15 friction points before getting a working setup.

---

## Critical Issues (blocks the user)

### 1. `SYNC_DEBUG_LIMIT=500` silently caps every sync

**Where:** `.env.example` line and `docker-compose.yml` default
**Impact:** A new user runs their first Gmail sync and only gets 500 emails. They have no idea data was capped. The quickstart doesn't mention this at all.
**Expected:** Default should be `0` (unlimited) for the Docker self-host path. The `500` default only makes sense for development. A user self-hosting via Docker is NOT a developer — they want all their data.
**Fix:** Set `SYNC_DEBUG_LIMIT=0` in `.env.example` and `docker-compose.yml`. Add a comment explaining what it does.

### 2. Telegram connector listed in README but has no docs

**Where:** README table lists "Telegram | Bot token | Messages, media, contacts"
**Impact:** `docs/connectors/telegram.md` does not exist. A user clicks through from the connectors index page and gets a 404. The connector package exists (`packages/connectors/telegram/`) but it's not registered in `connectors.service.ts` (grep returns empty).
**Fix:** Either add Telegram docs or mark it as "Coming Soon" in README and docs.

### 3. No Caddyfile in the repo despite deployment guide referencing it

**Where:** Deployment guide says "Create a Caddyfile (see docs/guide/deployment)" and `docker-compose.prod.yml` comments reference it
**Impact:** `Caddyfile` does not exist in the repo. A new user following the production deployment guide has no template to start from.
**Fix:** Add a sample `Caddyfile.example` to the repo.

### 4. Recovery key UX is under-documented for self-hosters

**Where:** Quickstart step 4 says "Create an Account" but doesn't mention the recovery key
**Impact:** After signup, a modal shows a base64 recovery key. The quickstart never warns the user to save it. If they dismiss it and the server restarts, all their connector credentials become inaccessible until they provide the key. The security docs explain this, but the quickstart — the only page a new user reads — does not.
**Fix:** Add a warning box in quickstart step 4: "Save your recovery key! You'll need it if the server restarts."

---

## Major Issues (causes confusion or wasted time)

### 5. README quick start differs from docs quickstart

**Where:** README "Docker (recommended)" section vs `docs/guide/quickstart.md`
**Impact:** README says `docker compose pull && docker compose up -d`. Docs quickstart has the same but adds much more context (Ollama setup, account creation, verification). A user who only reads the README will miss critical steps (pulling Ollama models, creating an account). README should link directly to the full quickstart.
**Current README:** Just 4 bash commands with no mention of Ollama model pulling.

### 6. Ollama is a hard prerequisite but presented as optional

**Where:** Quickstart prerequisites: "Ollama running somewhere on your network (or use OpenRouter as a cloud alternative)"
**Impact:** Without Ollama (and pulled models), the API starts but every sync job fails silently during embed/enrich. There's no health check that validates Ollama connectivity. A user who skips this step gets a running system that processes nothing — with no clear error message telling them why.
**Fix:** Make it explicit: "Ollama with models pulled is REQUIRED before your first sync. Without it, data ingestion will fail." Add a verification step.

### 7. `.env.example` has `DATABASE_URL` pointing to localhost, but Docker overrides it

**Where:** `.env.example`: `DATABASE_URL=postgresql://botmem:botmem@localhost:5432/botmem`; `docker-compose.yml` overrides to `postgres:5432`
**Impact:** Not a bug (the override works), but confusing. A new user edits `.env` thinking they need to set DATABASE_URL, when the compose file ignores their value entirely. The quickstart says "Edit as needed" but doesn't explain which vars matter in Docker vs dev mode.
**Fix:** Add comments in `.env.example` clarifying which variables are overridden by docker-compose.

### 8. No `docker compose` profile docs for optional services

**Where:** `docker-compose.yml` has `ollama` and `reranker` under `profiles:`
**Impact:** The quickstart never mentions `docker compose --profile ollama up -d` for users who want Ollama bundled. A user without a separate Ollama install has no idea they can spin one up via compose.
**Fix:** Add a tip in quickstart: "Don't have Ollama installed? Run `docker compose --profile ollama up -d` to include a bundled Ollama container."

### 9. `docker-compose.prod.yml` exists but README production section is a stub

**Where:** README "Production" section: 3 lines, points to a deployment guide at `docs.botmem.xyz/guide/deployment`
**Impact:** The deployment guide exists and is decent, but the README gives the impression you just `cp .env.example .env.prod && docker compose up` — no mention of secrets generation, Caddy setup, or SSL.

---

## Minor Issues (paper cuts)

### 10. Connector docs inconsistency — 7 connectors claimed, 6 documented

**Where:** README and docs connector index list 7 connectors. Only 6 have dedicated doc pages (Gmail, Slack, WhatsApp, iMessage, Immich, OwnTracks). Telegram has no doc page.
**Connectors index page** (`docs/connectors/index.md`) may list Telegram — needs verification on the live site.

### 11. OwnTracks config schema has confusing field overlap

**Where:** `docs/connectors/owntracks.md` setup table has both "Username" and "HTTP Auth Username" as separate fields
**Impact:** A new user doesn't know which is which. The "Username" is the OwnTracks user, "HTTP Auth Username" is for Basic auth — but this isn't clear.

### 12. No version pinning guidance

**Where:** `docker compose pull` always gets `:latest`
**Impact:** No guidance on pinning to a specific version. A user updating months later could get breaking changes. The troubleshooting section even recommends `docker compose down -v` (data wipe!) as the upgrade path.
**Fix:** Document version tags and a safe upgrade path that doesn't require data wipe.

### 13. Swagger UI link in docs points to `/api/docs` — relative path

**Where:** `docs/api/index.md` and `docs/api/openapi.md` reference `/api/docs` as a link
**Impact:** On docs.botmem.xyz, this resolves to `https://docs.botmem.xyz/api/docs` (404), not `http://localhost:12412/api/docs`. Should be documented as a localhost URL or the production URL.

### 14. `canonical` meta tag on docs site always points to root

**Where:** `<link rel="canonical" href="https://docs.botmem.xyz/">` on every page (visible in quickstart HTML)
**Impact:** SEO issue — every page claims to be the homepage. Not user-facing but affects discoverability.

### 15. No minimum hardware requirements documented

**Where:** Nowhere in quickstart, configuration, or deployment docs
**Impact:** A user doesn't know if their 1GB VPS can run this. The system needs PostgreSQL + Redis + Typesense + Ollama + the API. Realistically needs 4GB+ RAM minimum (8GB+ with Ollama). The deployment guide mentions nothing about resource requirements.

### 16. `.env.example` has commented-out sections with no clear "uncomment to enable" pattern

**Where:** SMTP, PostHog, Gmail, Slack sections in `.env.example`
**Impact:** Some vars are commented (`# SMTP_HOST=`), some are set to empty (`POSTHOG_API_KEY=`), some have placeholder values (`GMAIL_CLIENT_ID=your-google-client-id`). Inconsistent pattern — user doesn't know what's "off by default" vs "needs a value".

---

## What Works Well

- **docs.botmem.xyz is live** and returns 200. VitePress site renders correctly.
- **Quickstart happy path** (Docker section) is clear and sequential — 8 numbered steps.
- **Ollama model pull commands** are listed explicitly with correct model names.
- **Docker compose file** is well-structured with health checks on all services.
- **Security docs** clearly explain the recovery key system and why it exists.
- **Configuration docs** have a thorough env var table with defaults and descriptions.
- **Agent API / CLI docs** are comprehensive with examples.
- **Architecture docs** (pipeline, memory model, graph) are detailed and accurate.
- **OpenRouter alternative** is clearly documented for users without GPUs.
- **Troubleshooting section** addresses real gotchas (shell escaping, stale data).
