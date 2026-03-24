# Docker-Isolated External E2E Harness

This harness creates two fully isolated Docker environments in `/tmp` so E2E tests never touch your local Botmem data.

## What it creates

- `/tmp/botmem-e2e-selfhosted`
- `/tmp/botmem-e2e-managed`

Each root contains:

- dedicated `docker-compose.yml`
- dedicated `.env`
- dedicated runtime paths (`runtime/logs`, `runtime/temp`, `runtime/exports`, `runtime/plugins`)
- dedicated artifacts and reports
- issue ledger + search deep-dive templates

## Project names and volume prefixes

- `botmem_e2e_selfhosted`
- `botmem_e2e_managed`

Named volumes are prefixed with the project identifier and never reuse local defaults.

## Usage

```bash
# 1) Render isolated roots in /tmp
bash e2e/isolated/init.sh

# 2) Fill credentials in /tmp/botmem-e2e-selfhosted/.env and /tmp/botmem-e2e-managed/.env

# 3) Start mode
bash e2e/isolated/up.sh selfhosted
bash e2e/isolated/up.sh managed

# 4) Run external E2E suite against those endpoints

# 5) Tear down when done
bash e2e/isolated/down.sh selfhosted
bash e2e/isolated/down.sh managed
```

## Safety guarantees implemented

- Separate compose dirs in `/tmp`
- Separate compose project names
- Separate named volumes/networks
- Separate host ports (no overlap with local defaults)
- Mounts restricted to isolated `/tmp` roots
- Isolation check blocks if any repo-path mounts are detected

## Host ports

### Self-hosted

- App/API: `22412`
- Postgres: `25432`
- Redis: `26379`
- Typesense: `28108`
- Optional Ollama profile: `21434`

### Managed

- App/API: `32412`
- Postgres: `35432`
- Redis: `36379`
- Typesense: `38108`

## Reports and notes

Each mode has:

- `reports/ISSUE_LEDGER.csv`
- `reports/MASTER_E2E_REPORT.md`
- `reports/SEARCH_DEEP_DIVE.md`
- `reports/DOCS_MISMATCH_REPORT.md`
- `reports/SETUP_NOTES.md`
- `checklists/DATA_READINESS_CHECKLIST.md`
- `checklists/SEARCH_QUERY_PACK.md`

