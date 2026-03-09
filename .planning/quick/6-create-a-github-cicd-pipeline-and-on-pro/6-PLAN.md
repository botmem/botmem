---
phase: quick-6
plan: 6
type: execute
wave: 1
depends_on: []
files_modified:
  - .github/workflows/deploy.yml
  - /opt/botmem/docker-compose.prod.yml (VPS — via SSH)
  - /Users/amr/.claude/projects/-Users-amr-Projects-botmem/memory/MEMORY.md
autonomous: true
requirements: []

must_haves:
  truths:
    - 'Pushing to main triggers a GitHub Actions build that publishes ghcr.io/botmem/open-core:latest'
    - 'Watchtower on VPS polls GHCR every 30 seconds and auto-pulls/restarts the api container when a new image is published'
    - 'MEMORY.md deploy workflow updated — rsync+ssh steps removed, CI/CD description added'
  artifacts:
    - path: '.github/workflows/deploy.yml'
      provides: 'GitHub Actions workflow: build Docker image, push to GHCR'
    - path: '/opt/botmem/docker-compose.prod.yml'
      provides: 'Watchtower service added, api image switched from build to pre-built GHCR pull'
  key_links:
    - from: '.github/workflows/deploy.yml'
      to: 'ghcr.io/botmem/open-core:latest'
      via: 'docker/build-push-action'
    - from: 'Watchtower'
      to: 'ghcr.io/botmem/open-core:latest'
      via: 'DOCKER_REGISTRY env + WATCHTOWER_CREDENTIALS'
---

<objective>
Set up fully automated CI/CD so that `git push` is the entire deployment workflow.

Purpose: Replace the manual rsync + SSH rebuild workflow with GitHub Actions (build & push to GHCR) + Watchtower (auto-pull & restart on VPS). After this plan, deployments are: commit, push, wait for Actions to go green, done.

Output:

- `.github/workflows/deploy.yml` — builds Docker image on push to main, pushes to ghcr.io/botmem/open-core:latest
- VPS docker-compose.prod.yml updated — api service uses the pre-built GHCR image, Watchtower service added
- MEMORY.md updated — new workflow documented, old rsync+ssh steps removed
  </objective>

<execution_context>
@/Users/amr/.claude/get-shit-done/workflows/execute-plan.md
@/Users/amr/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@.planning/quick/6-create-a-github-cicd-pipeline-and-on-pro/6-PLAN.md

Key facts:

- GitHub org/repo: botmem/open-core (remote alias: open-core)
- VPS: root@65.20.85.57, deploy path /opt/botmem/
- Dockerfile is at repo root (already in open-core), build context is the repo root
- docker-compose.prod.yml is on VPS at /opt/botmem/docker-compose.prod.yml
- GHCR image name: ghcr.io/botmem/open-core:latest
- GitHub Actions uses GITHUB_TOKEN for GHCR auth (no extra secret needed for push)
- Watchtower needs GHCR read credentials: use a GitHub PAT with packages:read scope stored as VPS env var
- api container name on prod: botmem_api_1 or "api" (service name in compose)
- VPS SSH alias: botmem-ssh or root@65.20.85.57
  </context>

<tasks>

<task type="auto">
  <name>Task 1: Create GitHub Actions workflow (.github/workflows/deploy.yml)</name>
  <files>.github/workflows/deploy.yml</files>
  <action>
Create `.github/workflows/deploy.yml` that builds and pushes the Docker image to GHCR on every push to main.

Exact steps the workflow must perform:

1. Trigger: `on: push: branches: [main]`
2. Job: `build-and-push` running on `ubuntu-latest`
3. Steps:
   a. `actions/checkout@v4` (full checkout, no shallow clone needed)
   b. `docker/setup-buildx-action@v3` (enables BuildKit for layer caching)
   c. `docker/login-action@v3` with registry `ghcr.io`, username `${{ github.actor }}`, password `${{ secrets.GITHUB_TOKEN }}`
   d. `docker/build-push-action@v6` with:
   - `context: .` (build from repo root, Dockerfile is at root)
   - `file: ./Dockerfile`
   - `push: true`
   - `tags: ghcr.io/botmem/open-core:latest,ghcr.io/botmem/open-core:${{ github.sha }}`
   - `cache-from: type=gha`
   - `cache-to: type=gha,mode=max`
   - `platforms: linux/amd64` (VPS is amd64)

Also add `permissions` block at workflow level:

```yaml
permissions:
  contents: read
  packages: write
```

This is sufficient — GITHUB_TOKEN gets packages:write automatically in the same repo.
</action>
<verify>
<automated>cat /Users/amr/Projects/botmem/.github/workflows/deploy.yml | grep -E "ghcr.io|build-push-action|GITHUB_TOKEN" | wc -l</automated>
</verify>
<done>File exists with GHCR login, build-push-action config, and permissions block. Running `cat .github/workflows/deploy.yml` shows a valid YAML workflow with all required keys.</done>
</task>

<task type="auto">
  <name>Task 2: Update VPS docker-compose.prod.yml — switch api to GHCR image + add Watchtower</name>
  <files>/opt/botmem/docker-compose.prod.yml (via SSH)</files>
  <action>
SSH to root@65.20.85.57 and update /opt/botmem/docker-compose.prod.yml.

**Change 1 — api service:** Replace the `build:` block with a pre-built image reference:

Remove:

```yaml
build:
  context: ./open-core
  dockerfile: ../Dockerfile
```

Add:

```yaml
image: ghcr.io/botmem/open-core:latest
```

Keep everything else on the api service unchanged (ports, env_file, volumes, depends_on, restart).

**Change 2 — Add watchtower service** (at the end of the services block, before volumes):

```yaml
watchtower:
  image: containrrr/watchtower:latest
  restart: unless-stopped
  volumes:
    - /var/run/docker.sock:/var/run/docker.sock
  environment:
    - WATCHTOWER_POLL_INTERVAL=30
    - WATCHTOWER_CLEANUP=true
    - WATCHTOWER_INCLUDE_STOPPED=false
    - REPO_USER=botmem
    - REPO_PASS=${GHCR_TOKEN}
  command: api
```

The `command: api` restricts Watchtower to only watch the `api` container (service name).
The `REPO_USER` and `REPO_PASS` env vars are what Watchtower uses for private registry auth — it reads them from the environment. `GHCR_TOKEN` must be added to /opt/botmem/.env.prod as a GitHub PAT with `read:packages` scope.

**After editing the file:**

1. Add GHCR_TOKEN to /opt/botmem/.env.prod:

   ```
   GHCR_TOKEN=<generate a GitHub PAT at https://github.com/settings/tokens with read:packages scope>
   ```

   IMPORTANT: The executor cannot generate this token. Create a checkpoint note instructing the user to:
   - Go to https://github.com/settings/tokens/new
   - Select scope: `read:packages`
   - Name it: `botmem-watchtower`
   - Add the value to /opt/botmem/.env.prod as `GHCR_TOKEN=ghp_...`

2. Pull the image manually to verify GHCR access before starting Watchtower:

   ```bash
   ssh root@65.20.85.57 'docker pull ghcr.io/botmem/open-core:latest'
   ```

   (This will only work after the first GitHub Actions run completes and the image is published.)

3. After GHCR_TOKEN is in .env.prod, restart with:
   ```bash
   ssh root@65.20.85.57 'cd /opt/botmem && docker compose -f docker-compose.prod.yml up -d watchtower'
   ```

Note on timing: The api container will continue running from whatever image/build exists until the first GitHub Actions push publishes the image. Do NOT restart the api container until ghcr.io/botmem/open-core:latest exists.
</action>
<verify>
<automated>ssh root@65.20.85.57 'grep -E "ghcr.io|watchtower" /opt/botmem/docker-compose.prod.yml'</automated>
</verify>
<done>docker-compose.prod.yml on VPS contains `image: ghcr.io/botmem/open-core:latest` for the api service and a `watchtower` service block. `grep` confirms both strings are present.</done>
</task>

<task type="auto">
  <name>Task 3: Update MEMORY.md — replace manual deploy steps with CI/CD workflow</name>
  <files>/Users/amr/.claude/projects/-Users-amr-Projects-botmem/memory/MEMORY.md</files>
  <action>
Read MEMORY.md, then update the "Production Deployment" section:

**Remove** these lines from "Production Deployment":

- The `**Rebuild**:` line referencing `ssh root@... docker compose ... up -d --build`
- The `**Source sync**:` line referencing `rsync -az --delete ...`

**Replace** with new deploy workflow:

```
**Deploy workflow:** `git push origin main` → GitHub Actions builds Docker image → pushes to `ghcr.io/botmem/open-core:latest` → Watchtower on VPS polls GHCR every 30s and auto-pulls + restarts the `api` container. No manual steps required.
**GitHub Actions:** `.github/workflows/deploy.yml` — triggered on push to main, uses GITHUB_TOKEN for GHCR push
**Watchtower:** Running on VPS as a Docker service, polls `api` container only, needs `GHCR_TOKEN` in /opt/botmem/.env.prod (GitHub PAT with read:packages)
**Manual restart (if needed):** `ssh root@65.20.85.57 'cd /opt/botmem && docker compose -f docker-compose.prod.yml restart api'`
```

Keep all other lines in the Production Deployment section unchanged (URL, VPS IP, SSH, deploy path, containers, DNS, Docker notes).
</action>
<verify>
<automated>grep -c "rsync\|--build" /Users/amr/.claude/projects/-Users-amr-Projects-botmem/memory/MEMORY.md || true</automated>
</verify>
<done>MEMORY.md no longer contains the rsync or `--build` deploy commands. It contains the new CI/CD workflow description with Watchtower and GHCR references.</done>
</task>

<task type="checkpoint:human-verify" gate="blocking">
  <what-built>
    - .github/workflows/deploy.yml created (GitHub Actions: build + push to GHCR on push to main)
    - /opt/botmem/docker-compose.prod.yml updated on VPS (api uses GHCR image, watchtower service added)
    - MEMORY.md updated (old rsync+ssh deploy removed, new CI/CD workflow documented)
  </what-built>
  <how-to-verify>
    **Step 1 — Add GHCR_TOKEN to VPS .env.prod (required before Watchtower works):**
    1. Go to https://github.com/settings/tokens/new
    2. Name: `botmem-watchtower`, Expiration: No expiration (or 1 year)
    3. Scope: check `read:packages` only
    4. Copy the generated token
    5. SSH to VPS: `ssh root@65.20.85.57`
    6. Edit /opt/botmem/.env.prod and add: `GHCR_TOKEN=ghp_your_token_here`
    7. Save and exit

    **Step 2 — Push and watch Actions:**
    1. `cd /Users/amr/Projects/botmem`
    2. `git add .github/workflows/deploy.yml && git commit -m "ci: add GitHub Actions build + GHCR push workflow" && git push open-core main`
    3. Visit https://github.com/botmem/open-core/actions — watch the workflow run
    4. Wait for the green checkmark (~5-10 min for first build)

    **Step 3 — Make image public on GHCR (once after first push):**
    1. Visit https://github.com/orgs/botmem/packages or https://github.com/botmem/open-core/pkgs/container/open-core
    2. Go to Package Settings → Change visibility → Public (or keep private and ensure Watchtower GHCR_TOKEN is set)

    **Step 4 — Start Watchtower on VPS:**
    1. `ssh root@65.20.85.57 'cd /opt/botmem && docker compose -f docker-compose.prod.yml up -d watchtower'`
    2. Verify Watchtower is running: `ssh root@65.20.85.57 'docker ps | grep watchtower'`

    **Step 5 — Switch api to GHCR image:**
    (Only after Step 2 Actions workflow completes successfully)
    1. `ssh root@65.20.85.57 'cd /opt/botmem && docker compose -f docker-compose.prod.yml pull api && docker compose -f docker-compose.prod.yml up -d api'`
    2. Verify API is running: `curl https://botmem.xyz/api/version`

    **Step 6 — End-to-end validation:**
    Make a trivial change, push to main, wait ~10 min, confirm the prod API version updated without any SSH deploy steps.

  </how-to-verify>
  <resume-signal>Type "done" once the Actions workflow is green, Watchtower is running on VPS, and the API is serving from the GHCR image. Or describe any issues.</resume-signal>
</task>

</tasks>

<verification>
- `cat .github/workflows/deploy.yml` — valid YAML, triggers on main, uses ghcr.io, has permissions.packages: write
- `ssh root@65.20.85.57 'grep image /opt/botmem/docker-compose.prod.yml'` — shows ghcr.io/botmem/open-core:latest
- `ssh root@65.20.85.57 'docker ps | grep watchtower'` — Watchtower container running
- `curl https://botmem.xyz/api/version` — API responds
- `grep "rsync" /Users/amr/.claude/projects/-Users-amr-Projects-botmem/memory/MEMORY.md` — returns nothing
</verification>

<success_criteria>

- Pushing to main branch triggers the GitHub Actions workflow automatically
- Workflow builds Docker image and pushes ghcr.io/botmem/open-core:latest successfully
- Watchtower is running on VPS, polling only the `api` container every 30 seconds
- After a push + Actions completion, the prod API updates without any manual SSH/rsync steps
- MEMORY.md reflects the new workflow — no rsync or ssh+docker-compose-build deploy steps
  </success_criteria>

<output>
After completion, create `.planning/quick/6-create-a-github-cicd-pipeline-and-on-pro/6-SUMMARY.md` with what was built, files changed, and the new deploy workflow description.
</output>
