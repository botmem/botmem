# Botmem v2 database boundary

V2 has its own `botmem` schema, ownership role, migration history, and runtime
roles. It does not reuse the v1 journal or tables.

## Provisioning

1. As a cluster administrator, run `bootstrap/00_roles.sql` once.
2. Grant the deployment migrator login membership in `botmem_migrator` and grant
   `CREATE` on the target database to `botmem_schema_owner`.
3. Give each runtime login exactly one membership: `botmem_api`,
   `botmem_commerce`, `botmem_worker`, `botmem_lifecycle`, or
   `botmem_dispatcher`. All are `NOSUPERUSER NOBYPASSRLS`.
   A separate provisioning login may receive only `botmem_identity_admin`; the
   API login must never be a member of that role.
4. Install the `vector` extension in the target database as a provisioning
   administrator; the application runtime roles cannot create extensions.
5. Run the one-shot `@botmem-v2/migrator` image. It requires the exact
   `botmem_v2_migrator_login` → `botmem_migrator` → `botmem_schema_owner`
   boundary, a passwordless `DATABASE_URL` plus separate
   `DATABASE_PASSWORD`, and `migration/V1__initial_hosted_ingestion.sql` as
   the first migration. It serializes deploys with a PostgreSQL advisory lock,
   verifies ordered SHA-256 checksums, and commits each migration and immutable
   ledger row in the same transaction.
6. On every checked-out API or worker transaction, execute both statements
   before user-scoped SQL:

   ```sql
   SET LOCAL ROLE botmem_api; -- or botmem_worker
   SELECT set_config('botmem.tenant_id', :authenticated_tenant_id::text, true);
   ```

   Device registry, pairing, and challenge transactions additionally set the
   authenticated workspace. Their RLS policies require both values:

   ```sql
   SELECT set_config('botmem.workspace_id', :authenticated_workspace_id::text, true);
   ```

   The dispatcher sets `botmem_dispatcher`; it has cross-tenant access only to
   outbox delivery columns and cannot read connector accounts or event bodies.

Never connect an application with the schema owner or a role that bypasses RLS.

V4 adds workspace membership and opaque browser/PAT credentials. Raw credentials
are 256-bit random values returned once; PostgreSQL stores only a peppered
SHA-256 HMAC plus a non-secret display prefix. Credential lookup first sets only
the presented hash, whose RLS policy exposes at most that exact row, then sets
the resolved tenant/workspace/user context and rechecks active membership. The
launch constraint is intentionally one workspace per tenant (`workspace.id =
workspace.tenant_id`) so hosted search cannot accidentally confuse the two.
Browser cookies are `Secure`, `HttpOnly`, and `SameSite=Strict` in production;
unsafe cookie-authenticated HTTP requests also require an allowlisted `Origin`.

V6 stores one active short-lived device session identity per paired device. Its
monotonic generation prevents an older socket on another API replica from
reclaiming Redis presence after a reconnect. The table stores no relay frame,
query, result, local corpus, cursor, or plaintext secret. Live presence and
source readiness are TTL metadata; request/reply frames use Redis Pub/Sub only.
Email sign-in challenges use separate random 256-bit tokens, store only their
peppered HMAC, are single-use and workspace-bound, and put the delivered token
in the browser URL fragment so it does not enter HTTP access logs. Provisioning
computes `identity_user.email_lookup_hash` with the same HMAC key over the UTF-8
string `email:` followed by the NFKC-normalized, trimmed, lowercase address.
Challenge creation locks the matching identity row and suppresses another
outstanding link inside a 60-second delivery cooldown; the public response stays
identical to the unknown-account response. Per-IP abuse limits remain an ingress
responsibility because client IP trust depends on the deployment proxy chain.
The email-delivery adapter has an explicit readiness port; without a real ready
provider, login returns 503 and the runtime must not claim readiness.

Connector tokens are envelope-encrypted outside this schema; `credential_ref`
contains only an opaque secret-manager reference. `provider_subject_hash` is the
lowercase SHA-256 digest of the provider's durable account subject after the
connector anti-corruption adapter has applied its versioned canonicalization.
It prevents the same provider account from being connected twice within one
tenant without exposing the raw provider identifier.

V5 implements that vault boundary in PostgreSQL without weakening the model:
each credential has a random AES-256-GCM data key, and only the data key is
wrapped by the current versioned deployment key. API and worker RLS policies
require both `botmem.tenant_id` and `botmem.connector_account_id`; every vault
query also carries the tenant, account, connector, and opaque reference. OAuth
state is stored by digest and consumed through one atomic delete-returning
capability. Provider callback codes, PKCE verifiers, access/refresh tokens, and
OwnTracks Basic credentials must never enter request logs or API responses.

## Required page-commit transaction

The PostgreSQL adapter for `HostedIngestionUnitOfWork.commitPage` must use one
transaction at `SERIALIZABLE` (or lock the account/checkpoint rows explicitly):

1. Lock the tenant-scoped connector account and checkpoint.
2. Verify the active `connector_sync.id`, aggregate version, and cursor version.
3. For each provider revision, compare an existing row's `content_hash`. Equal
   means replay/no-op; unequal means an idempotency conflict.
4. Insert each unseen `ingest_event_revision`, atomically upsert its
   `ingest_event_head`, and insert exactly one `transactional_outbox` row.
5. Advance the checkpoint and aggregate versions.
6. Commit. Any conflict or outbox failure rolls back the entire page.

The unique partial index on active syncs is the final concurrency guard. Event
revisions are physically append-only; provider edits and tombstones create new
revisions. Projection consumers claim a `(projection_name, revision_id)` row
and repeat delivery of an already-applied identical output as a no-op.

The dispatcher can select only outbox routing/status columns and update only
lease/delivery columns. PostgreSQL denies it access to the outbox JSON payload,
connector accounts, and event revisions even though its outbox RLS policy is
cross-tenant.

V7 adds the durable hosted-sync scheduler. The API only coalesces tenant-scoped
requests into `hosted_sync_job`; the worker claims jobs with `SKIP LOCKED`, a
random lease token, and a bounded lease. An expired lease is reclaimable after a
crash, retries have a durable `available_at`, and a request arriving during a
run advances `request_version` so completion schedules exactly one follow-up.
Provider credentials and payloads are never placed in the queue. The connector
checkpoint advances only inside the successful page-commit transaction before
the durable job is completed.

API and sync worker processes must receive different database URLs and logins.
The API login is a member of only `botmem_api`; `WORKER_DATABASE_URL` is a login
that is a member of only `botmem_worker`. Do not point both pools at the same
login, grant either login the other runtime role, or give either login
`BYPASSRLS`/superuser. API readiness is fail-closed unless a sync-worker
heartbeat is fresh. Worker logs/metrics use stable failure codes and connector
kind only; tenant, account, provider payload, provider error text, and secrets
are excluded.

V8 adds Stripe commerce without giving the API identity-provisioning authority.
The API stores only a signature-verified, reduced webhook envelope under an
exact event-ID RLS capability and returns success after that commit. It never
stores the raw Stripe body. A standalone commerce reconciler leases the durable
envelopes, re-reads canonical Checkout/Subscription state, and is the only
process allowed to call the identity provisioner. Delivery order is not local
truth; `stripe_observed_at` is monotonic and a delayed event always triggers a
fresh Stripe read. Failed work returns to `pending` with bounded exponential
backoff, expired leases are crash-reclaimable, and the final attempt becomes
`dead_letter`.

The commerce process has two physically separate pools:

- `COMMERCE_DATABASE_URL`: a dedicated `NOSUPERUSER NOBYPASSRLS` login holding
  exactly `botmem_commerce` and no other Botmem role. It can claim and settle
  reconciliation work but cannot create checkout sessions or authenticate users.
- `IDENTITY_ADMIN_DATABASE_URL`: a different login holding exactly
  `botmem_identity_admin`; it cannot read commerce, content, credentials, or
  search tables.

The API Deployment must receive neither URL and must never receive
`STRIPE_RECONCILER_API_KEY`. The reconciler must receive no browser/session
pepper, webhook secret, OAuth client secret, connector-vault key, Redis URL, or
API database URL. API readiness is fail-closed until a reconciler heartbeat is
fresh.
