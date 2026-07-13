# Production health, privacy, and launch objectives

Operational telemetry is metadata, not a second memory store. Logs and health
signals must never contain workspace/user/account/device IDs, email addresses,
phone numbers, queries, message bodies, locations, provider URLs, OAuth state or
codes, tokens, database URLs, Redis frames, credential references, or raw
provider/driver errors.

Allowed fields are bounded enums: component, normalized HTTP route, method,
status class, connector kind, outcome, deployment version, and a reviewed stable
reason code. Unknown exceptions collapse to `unexpected_failure`. Request
correlation uses a random trace ID that is never derived from a durable user
identifier. Docker JSON logs rotate at 25 MiB with four files per container.

## What ships at launch

- API and projection containers expose readiness checks. API readiness includes
  PostgreSQL, Redis/device relay, login delivery, hosted-sync heartbeat,
  commerce heartbeat, lifecycle heartbeat, and lifecycle artifact storage.
- Deployment refuses promotion until projection is healthy and the API/Web
  canary passes. A shared operation lock prevents deployment and recovery from
  racing.
- `botmem-v2-health-recover.timer` runs every two minutes on Vultr. It recreates
  missing stateless services and restarts an unhealthy projection, stale hosted
  sync/commerce/lifecycle worker, stale API relay, or unavailable Web service.
  It deliberately never auto-restarts PostgreSQL or Redis; a persistent-state
  failure remains a failed systemd unit for operator investigation.
- `botmem-v2-backup.timer` performs the daily encrypted backup and disposable
  restore rehearsal.
- `.github/workflows/botmem-v2-uptime.yml` checks the public TLS API readiness
  and Web boundary every five minutes. A failure opens or updates one bounded
  GitHub incident; recovery closes it. The workflow stores only a reason code
  and run URL, never a response body. Enable it at public cutover with repository
  variables `BOTMEM_V2_PUBLIC_MONITOR_ENABLED=true`,
  `BOTMEM_V2_PUBLIC_API_ORIGIN`, and `BOTMEM_V2_PUBLIC_WEB_ORIGIN`.

The launch system does **not** claim that Prometheus, distributed tracing, log
shipping, or rolling SLO calculation exists. Those require a separately
reviewed privacy-preserving metrics deployment. Public readiness history and
GitHub workflow runs are the initial external availability record.

## Launch objectives

These are engineering objectives and benchmark gates, not a claim of measured
30-day attainment before production has accumulated data:

| Signal                                                                  |            Objective |
| ----------------------------------------------------------------------- | -------------------: |
| Authenticated API availability, excluding caller 4xx                    |                99.9% |
| Search requests returning a valid result/error contract before deadline |                99.5% |
| Search latency p95                                                      |      under 2 seconds |
| Hosted connector jobs completed without terminal failure                |     99% per 24 hours |
| Ingested hosted revisions searchable                                    | 99% within 5 minutes |
| Device relay requests while the signed client reports ready             |  99% before deadline |

## Triage

1. Check the public uptime workflow, `systemctl status
botmem-v2-health-recover.service`, Compose health, and current signed release.
2. Group by version, component, connector, and stable reason code. If a field
   resembles user data, disable that output and open a privacy incident.
3. For API failures, compare database/Redis health. For sync failures, inspect
   aggregate retry/dead counts. For projection lag, stop releases, verify both
   database roles, then inspect aggregate outbox age and embedding outcomes.
4. Roll back only to a schema-compatible signed digest. Follow
   `production-operations.md`; never reverse-migrate an existing volume.
5. Record aggregate counts and timestamps only. Attach no query, provider
   payload, credential, dump, or customer identifier.
