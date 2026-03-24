#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE_DIR="$SCRIPT_DIR/templates"

SELF_ROOT="${BOTMEM_E2E_SELF_ROOT:-/tmp/botmem-e2e-selfhosted}"
MANAGED_ROOT="${BOTMEM_E2E_MANAGED_ROOT:-/tmp/botmem-e2e-managed}"

mkdir -p "$SELF_ROOT" "$MANAGED_ROOT"

render_mode() {
  local mode="$1"
  local root="$2"
  local compose_template="$TEMPLATE_DIR/docker-compose.${mode}.yml"
  local env_template="$TEMPLATE_DIR/.env.${mode}.example"

  mkdir -p \
    "$root/runtime/logs" \
    "$root/runtime/temp" \
    "$root/runtime/exports" \
    "$root/runtime/plugins" \
    "$root/artifacts" \
    "$root/reports" \
    "$root/checklists"

  cp "$compose_template" "$root/docker-compose.yml"

  if [[ ! -f "$root/.env" ]]; then
    cp "$env_template" "$root/.env"
  fi

  cp "$TEMPLATE_DIR/reporting/ISSUE_LEDGER.csv" "$root/reports/ISSUE_LEDGER.csv"
  cp "$TEMPLATE_DIR/reporting/MASTER_E2E_REPORT.md" "$root/reports/MASTER_E2E_REPORT.md"
  cp "$TEMPLATE_DIR/reporting/SEARCH_DEEP_DIVE.md" "$root/reports/SEARCH_DEEP_DIVE.md"
  cp "$TEMPLATE_DIR/reporting/DOCS_MISMATCH_REPORT.md" "$root/reports/DOCS_MISMATCH_REPORT.md"
  cp "$TEMPLATE_DIR/reporting/SETUP_NOTES.md" "$root/reports/SETUP_NOTES.md"
  cp "$TEMPLATE_DIR/checklists/DATA_READINESS_CHECKLIST.md" "$root/checklists/DATA_READINESS_CHECKLIST.md"
  cp "$TEMPLATE_DIR/checklists/SEARCH_QUERY_PACK.md" "$root/checklists/SEARCH_QUERY_PACK.md"
}

render_mode "selfhosted" "$SELF_ROOT"
render_mode "managed" "$MANAGED_ROOT"

cat <<MSG
Isolated E2E roots initialized:
- $SELF_ROOT
- $MANAGED_ROOT

Next:
1. Fill each .env with credentials.
2. Run: bash e2e/isolated/up.sh selfhosted
3. Run: bash e2e/isolated/up.sh managed
MSG
