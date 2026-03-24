#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-}"
if [[ -z "$MODE" ]]; then
  echo "Usage: $0 <selfhosted|managed>" >&2
  exit 1
fi

case "$MODE" in
  selfhosted)
    ROOT="${BOTMEM_E2E_SELF_ROOT:-/tmp/botmem-e2e-selfhosted}"
    BASE_URL="${BOTMEM_E2E_BASE_URL:-http://localhost:22412}"
    ;;
  managed)
    ROOT="${BOTMEM_E2E_MANAGED_ROOT:-/tmp/botmem-e2e-managed}"
    BASE_URL="${BOTMEM_E2E_BASE_URL:-http://localhost:32412}"
    ;;
  *)
    echo "Invalid mode: $MODE" >&2
    exit 1
    ;;
esac

ART_DIR="$ROOT/artifacts"
REP_DIR="$ROOT/reports"
ISSUE_LEDGER="$REP_DIR/ISSUE_LEDGER.csv"
TOKEN="${BOTMEM_TEST_ACCESS_TOKEN:-}"

mkdir -p "$ART_DIR" "$REP_DIR"

append_issue() {
  local id="$1"
  local surface="$2"
  local category="$3"
  local observed="$4"
  local expected="$5"
  local repro="$6"
  local evidence="$7"
  local severity="$8"
  local status="$9"
  local docs_ref="${10}"

  local now
  now="$(date -u +%FT%TZ)"
  printf '%s,%s,%s,%s,%s,"%s","%s","%s","%s",%s,%s,%s\n' \
    "$id" "$now" "$MODE" "$surface" "$category" "$observed" "$expected" "$repro" "$evidence" "$severity" "$status" "$docs_ref" \
    >> "$ISSUE_LEDGER"
}

http_get() {
  local path="$1"
  local out="$2"
  local code
  code=$(curl -sS -o "$out" -w '%{http_code}' "$BASE_URL$path" || true)
  echo "$code"
}

http_get_auth() {
  local path="$1"
  local out="$2"
  local code
  code=$(curl -sS -o "$out" -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "$BASE_URL$path" || true)
  echo "$code"
}

run_smoke() {
  local code

  code=$(http_get "/api/version" "$ART_DIR/version.json")
  if [[ "$code" != "200" ]]; then
    append_issue "E2E-SMOKE-001" "api" "Setup" "GET /api/version returned $code" "200" "curl $BASE_URL/api/version" "$ART_DIR/version.json" "P0" "open" "docs/api/index.md"
  fi

  code=$(http_get "/api/health" "$ART_DIR/health.json")
  if [[ "$code" != "200" ]]; then
    append_issue "E2E-SMOKE-002" "api" "Setup" "GET /api/health returned $code" "200" "curl $BASE_URL/api/health" "$ART_DIR/health.json" "P0" "open" "docs/api/index.md"
  fi

  code=$(http_get "/api/connectors" "$ART_DIR/connectors.json")
  if [[ "$code" != "200" ]]; then
    append_issue "E2E-SMOKE-003" "api" "Setup" "GET /api/connectors returned $code" "200" "curl $BASE_URL/api/connectors" "$ART_DIR/connectors.json" "P0" "open" "docs/api/connectors.md"
  fi
}

run_auth_smoke() {
  if [[ -z "$TOKEN" ]]; then
    echo "BOTMEM_TEST_ACCESS_TOKEN not set; skipping authenticated stream" | tee "$ART_DIR/auth-skipped.log"
    return
  fi

  local code
  code=$(http_get_auth "/api/accounts" "$ART_DIR/accounts.json")
  if [[ "$code" != "200" ]]; then
    append_issue "E2E-AUTH-001" "api" "Auth" "GET /api/accounts returned $code" "200 with valid access token" "curl -H 'Authorization: Bearer ...' $BASE_URL/api/accounts" "$ART_DIR/accounts.json" "P1" "open" "docs/api/connectors.md"
  fi

  code=$(http_get_auth "/api/jobs" "$ART_DIR/jobs.json")
  if [[ "$code" != "200" ]]; then
    append_issue "E2E-AUTH-002" "api" "Auth" "GET /api/jobs returned $code" "200 with valid access token" "curl -H 'Authorization: Bearer ...' $BASE_URL/api/jobs" "$ART_DIR/jobs.json" "P1" "open" "docs/api/jobs.md"
  fi

  code=$(http_get_auth "/api/memories/stats" "$ART_DIR/memory-stats.json")
  if [[ "$code" != "200" ]]; then
    append_issue "E2E-AUTH-003" "api" "Auth" "GET /api/memories/stats returned $code" "200 with valid access token" "curl -H 'Authorization: Bearer ...' $BASE_URL/api/memories/stats" "$ART_DIR/memory-stats.json" "P1" "open" "docs/api/memories.md"
  fi
}

run_mcp_smoke() {
  local out="$ART_DIR/mcp-no-auth.json"
  local code
  code=$(curl -sS -o "$out" -w '%{http_code}' -X POST "$BASE_URL/mcp" -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' || true)

  if [[ "$code" != "401" ]]; then
    append_issue "E2E-MCP-001" "mcp" "Auth" "POST /mcp without token returned $code" "401" "POST initialize to /mcp without Authorization" "$out" "P1" "open" "docs/agent-api/openclaw.md"
  fi
}

{
  echo "[$(date -u +%FT%TZ)] Starting baseline stream mode=$MODE base=$BASE_URL"
  run_smoke
  run_auth_smoke
  run_mcp_smoke
  echo "[$(date -u +%FT%TZ)] Baseline stream complete"
} | tee "$ART_DIR/test-streams-${MODE}.log"

