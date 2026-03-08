# Phase 11: Repository & Infrastructure Foundation - Research

**Researched:** 2026-03-08
**Domain:** Git history sanitization, GitHub org/repo setup, VPS provisioning, DNS configuration
**Confidence:** HIGH

## Summary

Phase 11 is an infrastructure-only phase with no application code changes. It covers four discrete workstreams: (1) cleaning inline secrets from source files and git history, (2) creating the GitHub org with public open-core and private prod-core repos, (3) configuring a Vultr VPS with Docker and security hardening, and (4) pointing DNS for botmem.xyz to the VPS.

The codebase has ~149 commits. Secrets (Google OAuth client ID/secret, Slack user token, OwnTracks credentials) appear 13+ times in git history, primarily in `.claude-flow/` data files that cached MEMORY.md content. The working tree is mostly clean of real secrets (they live in user-local `~/.claude/` MEMORY.md), but git history must be rewritten before any public push.

**Primary recommendation:** Clean inline secrets first (working tree), then use `git-filter-repo --replace-text` on a fresh clone to sanitize history, then push the sanitized main branch to the new public repo. VPS and DNS work are independent and can be parallelized.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- Use `git-filter-repo` to rewrite history and remove secrets
- Push only main branch to the public repo (no feature branches)
- Credentials are test-only -- no rotation needed after push
- One-time secret pattern grep before push (no CI check for this phase)
- Patterns to scan: OAuth client secrets (`GOCSPX-*`), Slack tokens (`xoxp-*`), any API keys
- Open-core is the primary repo with the full working application
- Prod-core is a thin private repo with production configs only
- Prod-core consumes open-core via Docker image from GHCR
- Prod-core never clones or contains open-core source code
- Prod-core contains: docker-compose.prod.yml, Caddyfile, .env.prod.example, business docs, monitoring configs
- No deploy scripts in prod-core (deferred -- Phase 15 handles CI/CD)
- Open-core includes a basic docker-compose.yml for self-hosters
- Replace all hardcoded secrets with environment variables + `.env.example` with placeholders
- Test files use mocked/stubbed values -- no real credentials needed
- Clean CLAUDE.md -- remove 'Test Credentials' section
- Clean PROJECT_OVERVIEW.md -- redact credential values, keep file
- Files requiring cleanup: `slack.test.ts`, `oauth.ts`, `quickstart.md`, `connectors.md`, `slack.md`, `PROJECT_OVERVIEW.md`, `CLAUDE.md`
- User provisions Vultr VPS manually and provides SSH access
- Claude configures the box: Docker, Docker Compose, 2GB swap, firewall (ports 22, 80, 443)
- No scripted provisioning (cloud-init/Ansible) -- direct SSH commands

### Claude's Discretion
- Exact git-filter-repo expressions and replacement patterns
- Order of operations (clean secrets first vs split repos first)
- Docker Compose structure for the self-hoster compose file
- VPS configuration commands and security hardening details

### Deferred Ideas (OUT OF SCOPE)
- CI secret scanning check on every push -- Phase 15
- Deploy scripts -- Phase 15
- Dockerfile for GHCR image -- Phase 14
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| REPO-01 | GitHub org `botmem` is created and configured | gh CLI with admin:org scope is authenticated; org creation via `gh api` POST |
| REPO-02 | Open-core public repo with sanitized git history | git-filter-repo installed (homebrew); replace-text for secret patterns; push main only |
| REPO-03 | Prod-core private repo with deployment configs | gh CLI repo creation; thin repo with docker-compose.prod.yml, Caddyfile, .env.prod.example |
| REPO-04 | Git history sanitized to remove all credentials | 13+ secret occurrences in history identified; expressions.txt patterns documented |
| DEP-01 | Vultr VPS provisioned with Docker, swap, firewall | User provisions VPS; Claude configures via SSH with documented commands |
| DEP-05 | Spaceship DNS A record for botmem.xyz | Manual DNS configuration in Spaceship registrar panel |
</phase_requirements>

## Standard Stack

### Core Tools
| Tool | Version | Purpose | Why Standard |
|------|---------|---------|--------------|
| git-filter-repo | a40bce5 (latest) | Rewrite git history to remove secrets | GitHub-recommended replacement for filter-branch; already installed via Homebrew |
| gh CLI | authenticated | GitHub org/repo creation, GHCR setup | Already authenticated with `admin:org`, `repo` scopes |
| Docker Engine | latest stable | Container runtime on VPS | Standard for deployment |
| Docker Compose | v2 (plugin) | Multi-container orchestration | Ships with Docker Engine |
| UFW | system | VPS firewall | Ubuntu default, simple rule-based |

### Supporting
| Tool | Purpose | When to Use |
|------|---------|-------------|
| grep/rg | Pre-push secret scanning | One-time verification before public push |
| ssh | VPS configuration | Direct commands after user provides access |
| Spaceship DNS panel | DNS A record | Manual step by user |

## Architecture Patterns

### Recommended Order of Operations

```
Phase 11 Execution Order:
1. Clean inline secrets in working tree (source files)
2. Commit clean working tree to main
3. Fresh clone → git-filter-repo --replace-text → sanitized repo
4. Verify: grep for secret patterns returns zero matches
5. Create GitHub org "botmem"
6. Create public "open-core" repo, push sanitized main
7. Create private "prod-core" repo, populate with config templates
8. [Independent] VPS configuration via SSH
9. [Independent] DNS A record configuration
```

### Open-Core Repo Structure
```
open-core/                    # Public repo (full application)
├── apps/
│   ├── api/                  # NestJS backend
│   └── web/                  # React frontend
├── packages/
│   ├── cli/                  # botmem CLI
│   ├── connector-sdk/        # BaseConnector
│   ├── connectors/           # All connector packages
│   └── shared/               # Shared types
├── docs/                     # Documentation (VitePress)
├── docker-compose.yml        # Self-hoster compose (NEW)
├── .env.example              # Environment variable template (NEW)
├── .gitignore
├── package.json
├── turbo.json
└── README.md
```

### Prod-Core Repo Structure
```
prod-core/                    # Private repo (deployment configs only)
├── docker-compose.prod.yml   # Production orchestration (references GHCR image)
├── Caddyfile                 # Reverse proxy + auto SSL
├── .env.prod.example         # Production env template
├── business/                 # GTM docs, analytics configs
├── monitoring/               # Future: monitoring configs
└── README.md                 # Deployment instructions
```

### Self-Hoster Docker Compose Pattern
```yaml
# docker-compose.yml (in open-core)
services:
  api:
    build: .                   # Uses local Dockerfile (Phase 14 adds this)
    # image: ghcr.io/botmem/open-core:latest  # Alternative: pre-built
    ports:
      - "12412:12412"
    environment:
      - DB_PATH=/data/botmem.db
      - REDIS_URL=redis://redis:6379
      - QDRANT_URL=http://qdrant:6333
      - OLLAMA_BASE_URL=${OLLAMA_BASE_URL:-http://host.docker.internal:11434}
    volumes:
      - botmem-data:/data
    depends_on:
      - redis
      - qdrant

  redis:
    image: redis:7-alpine
    volumes:
      - redis-data:/data

  qdrant:
    image: qdrant/qdrant:latest
    volumes:
      - qdrant-data:/qdrant/storage

volumes:
  botmem-data:
  redis-data:
  qdrant-data:
```

**Note:** The Dockerfile does not exist yet (Phase 14 scope). The self-hoster compose should reference `build: .` as a forward reference, with a comment noting the Dockerfile is coming. Alternatively, omit the `api` service for now and only include Redis + Qdrant (matching current dev compose), adding the full stack in Phase 14.

### Prod-Core Docker Compose Pattern
```yaml
# docker-compose.prod.yml (in prod-core)
services:
  api:
    image: ghcr.io/botmem/open-core:latest
    ports:
      - "127.0.0.1:12412:12412"
    env_file: .env.prod
    volumes:
      - botmem-data:/data
    depends_on:
      - redis
      - qdrant
    restart: unless-stopped

  redis:
    image: redis:7-alpine
    volumes:
      - redis-data:/data
    restart: unless-stopped

  qdrant:
    image: qdrant/qdrant:latest
    volumes:
      - qdrant-data:/qdrant/storage
    restart: unless-stopped

  caddy:
    image: caddy:2-alpine
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile
      - caddy-data:/data
      - caddy-config:/config
    restart: unless-stopped

volumes:
  botmem-data:
  redis-data:
  qdrant-data:
  caddy-data:
  caddy-config:
```

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Git history rewriting | Custom scripts with git filter-branch | `git-filter-repo --replace-text` | filter-branch is deprecated; filter-repo is faster, safer, GitHub-recommended |
| Secret detection | Manual file-by-file review | `grep -rn` with specific patterns + `git log --all -p \| grep` | Systematic, catches history too |
| VPS firewall | Raw iptables rules | UFW (Uncomplicated Firewall) | Simple declarative rules, Ubuntu default |
| Reverse proxy + SSL | nginx + certbot | Caddy | Auto HTTPS, zero-config Let's Encrypt, single binary |
| GitHub org/repo setup | Web UI clicking | `gh` CLI API calls | Scriptable, reproducible, already authenticated |

## Common Pitfalls

### Pitfall 1: git-filter-repo Requires Fresh Clone
**What goes wrong:** Running git-filter-repo on the working repo fails or corrupts it
**Why it happens:** git-filter-repo has a safety check -- it refuses to run on non-fresh clones to prevent data loss
**How to avoid:** Always `git clone --no-local /path/to/repo /tmp/botmem-clean` first, then run filter-repo on the clone
**Warning signs:** Error message about "fresh clone" or "not a fresh clone"

### Pitfall 2: Secrets in Encoded/Embedded Forms
**What goes wrong:** `--replace-text` misses secrets embedded in URL-encoded strings, JSON blobs, or base64
**Why it happens:** The OAuth client ID `349660224573` appears in URL-encoded OAuth redirect URLs in `.claude-flow/` session recordings
**How to avoid:** Include the raw secret substrings (not just the full credential) in the expressions file. For example, include `349660224573` not just the full client ID string
**Warning signs:** Post-filter grep still finds matches

### Pitfall 3: Remote Origin After filter-repo
**What goes wrong:** `git push` fails after running filter-repo because it removes all remotes
**Why it happens:** git-filter-repo strips remotes as a safety measure (prevents pushing rewritten history to the wrong place)
**How to avoid:** Add the new remote manually after filter-repo completes: `git remote add origin git@github.com:botmem/open-core.git`

### Pitfall 4: UFW + Docker Port Bypass
**What goes wrong:** Docker published ports bypass UFW rules entirely
**Why it happens:** Docker manipulates iptables directly, inserting rules before UFW chains
**How to avoid:** Either (a) bind Docker ports to 127.0.0.1 only and use Caddy as reverse proxy, or (b) use Vultr's cloud firewall (network-level, not host-level)
**Warning signs:** Services accessible on blocked ports despite UFW deny rules

### Pitfall 5: .claude-flow Data Files in History
**What goes wrong:** Secret scanning misses credentials buried in `.claude-flow/` JSON state files
**Why it happens:** These files cached MEMORY.md content which contains real credentials
**How to avoid:** The expressions.txt for git-filter-repo should target the actual secret values, not just file paths. Also consider `--invert-paths --path .claude-flow/` to remove these files from history entirely since they're gitignored anyway

### Pitfall 6: GitHub Org Name Availability
**What goes wrong:** The org name "botmem" might already be taken
**Why it happens:** GitHub org/user namespaces are global
**How to avoid:** Check availability first: `gh api /orgs/botmem` (404 = available). Current check shows 404, so it appears available
**Warning signs:** 422 error on org creation

## Code Examples

### git-filter-repo Expressions File

```
# expressions.txt -- one pattern per line
# Format: LITERAL==>REPLACEMENT  or  regex:PATTERN==>REPLACEMENT

# Google OAuth Client Secret
<REDACTED_GOOGLE_CLIENT_SECRET>==>REDACTED_GOOGLE_CLIENT_SECRET

# Google OAuth Client ID
<REDACTED_GOOGLE_CLIENT_ID>==>REDACTED_GOOGLE_CLIENT_ID

# Slack User Token
<REDACTED_SLACK_TOKEN>==>REDACTED_SLACK_TOKEN

# OwnTracks Password
cJ5wnFUyeAF/9MXm7J44xg====>REDACTED_OWNTRACKS_PASSWORD

# OwnTracks URL (contains internal hostname)
owntracks.home.covidvpn.me==>REDACTED_OWNTRACKS_HOST
```

Source: [git-filter-repo documentation](https://www.mankier.com/1/git-filter-repo), [GitHub removing sensitive data guide](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository)

### History Sanitization Workflow

```bash
# 1. Fresh clone (required by git-filter-repo)
git clone --no-local /path/to/botmem /tmp/botmem-clean
cd /tmp/botmem-clean

# 2. Remove .claude-flow files from history entirely (they're gitignored)
git filter-repo --invert-paths --path-glob '*.claude-flow/*' --force

# 3. Replace remaining secret text patterns
git filter-repo --replace-text /path/to/expressions.txt --force

# 4. Verify -- must return 0 matches
git log --all -p | grep -cE 'GOCSPX|xoxp-8252|349660224573|571fe0c3|cJ5wnFUyeAF|owntracks.home.covidvpn'

# 5. Push only main branch to new public repo
git remote add origin git@github.com:botmem/open-core.git
git push -u origin main
```

### GitHub Org and Repo Creation

```bash
# Create org (requires admin:org scope -- confirmed available)
gh api -X POST /user/orgs \
  -f login="botmem" \
  -f profile_name="Botmem" \
  -f billing_email="amroessams@gmail.com"

# Create public repo
gh repo create botmem/open-core --public \
  --description "Personal memory RAG system -- ingest, search, and query across all your communications"

# Create private repo
gh repo create botmem/prod-core --private \
  --description "Production deployment configs for botmem.xyz"
```

### VPS Configuration Commands

```bash
# SSH into VPS (user provides IP)
ssh root@<VPS_IP>

# --- Swap (2GB) ---
fallocate -l 2G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab

# --- Docker ---
apt-get update && apt-get install -y ca-certificates curl gnupg
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null
apt-get update && apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# --- Firewall ---
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp    # SSH
ufw allow 80/tcp    # HTTP
ufw allow 443/tcp   # HTTPS
ufw --force enable

# --- Verify ---
docker --version
docker compose version
swapon --show
ufw status verbose
```

Source: [Vultr Docker docs](https://docs.vultr.com/how-to-use-vultrs-docker-marketplace-application), [Vultr swap guide](https://docs.vultr.com/how-to-add-swap-memory-in-ubuntu-24-04), [Vultr UFW guide](https://docs.vultr.com/how-to-configure-ufw-firewall)

### .env.example Template

```bash
# Botmem Environment Configuration
# Copy to .env and fill in values

# Server
PORT=12412

# Database (SQLite -- default for self-hosting)
DB_PATH=./data/botmem.db

# Redis (BullMQ queue backend)
REDIS_URL=redis://localhost:6379

# Qdrant (vector search)
QDRANT_URL=http://localhost:6333

# Ollama (AI inference -- required)
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_EMBED_MODEL=nomic-embed-text
OLLAMA_TEXT_MODEL=qwen3:0.6b
OLLAMA_VL_MODEL=qwen3-vl:2b

# Frontend
FRONTEND_URL=http://localhost:12412

# OAuth (optional -- configure for Gmail/Slack connectors)
# GMAIL_CLIENT_ID=your-google-client-id
# GMAIL_CLIENT_SECRET=your-google-client-secret
# SLACK_CLIENT_ID=your-slack-client-id
# SLACK_CLIENT_SECRET=your-slack-client-secret
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| git filter-branch | git-filter-repo | 2020+ | 10-100x faster, safer, GitHub-recommended |
| certbot + nginx | Caddy | 2020+ | Zero-config HTTPS, simpler config |
| Docker Compose v1 (standalone) | Docker Compose v2 (plugin) | 2023 | `docker compose` (no hyphen), ships with Docker Engine |
| iptables | UFW | Standard on Ubuntu | Simpler rule management |

## Open Questions

1. **Self-hoster compose without Dockerfile**
   - What we know: Dockerfile is Phase 14 scope; self-hoster compose needs an `api` service
   - What's unclear: Should the Phase 11 self-hoster compose include an `api` service that won't work yet, or just Redis + Qdrant?
   - Recommendation: Include the full compose with `build: .` and a comment that Dockerfile is added in Phase 14. This sets the intent clearly.

2. **VPS OS version**
   - What we know: Vultr offers Ubuntu 22.04 LTS and 24.04 LTS
   - What's unclear: Which version the user will choose
   - Recommendation: Commands work on both; Docker install uses `$VERSION_CODENAME` for compatibility

3. **DNS propagation timing**
   - What we know: DNS changes can take up to 48 hours to propagate globally
   - What's unclear: Spaceship's typical propagation time
   - Recommendation: Set low TTL (300s) on initial A record; verify with `dig botmem.xyz`

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Manual verification (infrastructure phase, no code tests) |
| Config file | N/A |
| Quick run command | `git log --all -p \| grep -cE 'GOCSPX\|xoxp-8252\|349660224573'` |
| Full suite command | See verification commands below |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| REPO-01 | GitHub org exists | smoke | `gh api /orgs/botmem --jq .login` | N/A |
| REPO-02 | Public repo with clean history | smoke | `gh repo view botmem/open-core --json visibility` | N/A |
| REPO-03 | Private repo with configs | smoke | `gh repo view botmem/prod-core --json visibility` | N/A |
| REPO-04 | No secrets in git history | automated | `git log --all -p \| grep -cE 'GOCSPX\|xoxp-8252\|349660224573\|571fe0c3\|cJ5wnFUyeAF'` (must be 0) | N/A |
| DEP-01 | VPS with Docker, swap, firewall | smoke | `ssh root@<IP> 'docker --version && swapon --show && ufw status'` | N/A |
| DEP-05 | DNS A record resolves | smoke | `dig +short botmem.xyz` (returns VPS IP) | N/A |

### Sampling Rate
- **Per task:** Run relevant verification command after each task
- **Phase gate:** All 6 verification commands must pass

### Wave 0 Gaps
None -- this is an infrastructure phase with no test framework requirements. Verification is command-based.

## Sources

### Primary (HIGH confidence)
- [GitHub Docs: Removing sensitive data](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository) - git-filter-repo recommended approach
- [git-filter-repo man page](https://www.mankier.com/1/git-filter-repo) - --replace-text syntax and --invert-paths usage
- [Vultr Docs: Swap memory](https://docs.vultr.com/how-to-add-swap-memory-in-ubuntu-24-04) - swap setup commands
- [Vultr Docs: UFW firewall](https://docs.vultr.com/how-to-configure-ufw-firewall) - firewall configuration
- [Vultr Docs: Docker marketplace](https://docs.vultr.com/how-to-use-vultrs-docker-marketplace-application) - Docker installation
- [GitHub Docs: Container registry](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry) - GHCR setup
- Local codebase analysis: git history secret scan, `.gitignore` review, docker-compose.yml review, `gh auth status`

### Secondary (MEDIUM confidence)
- [Vultr security best practices](https://docs.vultr.com/security-best-practices-for-vultr-instances) - VPS hardening
- [git-filter-repo tutorial (Octocurious)](https://octocurious.com/blog/20240525-git-filter-repo/) - practical examples

### Tertiary (LOW confidence)
- UFW + Docker port bypass behavior -- well-known issue, multiple community sources confirm, but exact Docker version behavior may vary

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - all tools verified installed/authenticated locally
- Architecture: HIGH - repo split pattern is well-understood; existing codebase analyzed
- Pitfalls: HIGH - secrets in history confirmed via grep; UFW+Docker is a well-documented gotcha
- VPS commands: MEDIUM - commands are standard but exact OS version unknown until user provisions

**Research date:** 2026-03-08
**Valid until:** 2026-04-08 (infrastructure patterns are stable)
