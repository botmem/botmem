# Isolated E2E Runbook

This runbook executes E2E against isolated Docker environments only.

## 0) Initialize

```bash
bash e2e/isolated/init.sh
```

Fill:

- `/tmp/botmem-e2e-selfhosted/.env`
- `/tmp/botmem-e2e-managed/.env`

## 1) Start environments

```bash
bash e2e/isolated/up.sh selfhosted
bash e2e/isolated/up.sh managed
```

## 2) Baseline automation stream (non-interactive)

Run with access token(s) when available:

```bash
BOTMEM_TEST_ACCESS_TOKEN="..." bash e2e/isolated/test-streams.sh selfhosted
BOTMEM_TEST_ACCESS_TOKEN="..." bash e2e/isolated/test-streams.sh managed
```

What it checks automatically:

- API/version/health
- connector registry
- authenticated APIs if token provided (`/accounts`, `/jobs`, `/memories/stats`)
- MCP auth behavior smoke (`401` without token)

All output goes to mode-specific `artifacts/` and issues are appended to `reports/ISSUE_LEDGER.csv`.

## 3) Interactive connector flows

### Required live operator actions

- WhatsApp: QR scan
- Telegram: OTP entry
- Managed mode: Stripe webhook ngrok URL + secret

### Checklist order (per mode)

1. user creation + recovery key baseline
2. connector auth + sync: gmail, slack, whatsapp, telegram, imessage, photos, locations
3. retrieval: search/ask/timeline/graph/related
4. CLI stream
5. OAuth + MCP stream
6. OpenClaw plugin stream
7. failure/recovery stream

Use:

- `checklists/DATA_READINESS_CHECKLIST.md`
- `checklists/SEARCH_QUERY_PACK.md`

## 4) Report writing

Update these files per mode:

- `reports/MASTER_E2E_REPORT.md`
- `reports/SEARCH_DEEP_DIVE.md`
- `reports/DOCS_MISMATCH_REPORT.md`
- `reports/SETUP_NOTES.md`
- `reports/ISSUE_LEDGER.csv`

## 5) Teardown

```bash
bash e2e/isolated/down.sh selfhosted
bash e2e/isolated/down.sh managed
```

