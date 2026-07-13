# Production operations

Botmem v2 runs on the existing Vultr x86_64 host as Docker Compose services.
Operators reach that host with `ssh botmem`; GitHub Actions uses the same host
through a dedicated key and a checked-in workflow. Docker Compose is the only
Botmem production deployment path.

## Production boundary

- `/opt/botmem-v2/config.env` contains non-secret, persistent production
  settings and is created from `deploy/vps/config.env.example`.
- `/opt/botmem-v2/secrets/` contains mode-0600 credential files. Runtime
  containers receive only `*_FILE` paths. Secret values are never written to a
  Compose environment, release file, image, CI artifact, or command log.
- `/opt/botmem-v2/releases/<commit>/` contains versioned Compose assets and the
  nine immutable `image@sha256` references for one release.
- `/opt/botmem-v2/current` and `/opt/botmem-v2/release.env` are atomic symlinks
  to the active assets and release references.
- PostgreSQL 17/pgvector and Caddy are Botmem-built, SBOMed, keyless-signed
  images. The database rebuilds `gosu` with the pinned patched Go toolchain and
  applies Debian security updates; the edge rebuilds stock Caddy from its
  immutable release tag with that toolchain. Redis uses a fixed clean upstream
  Alpine digest. All three are vulnerability-gated. PostgreSQL and Redis accept
  TLS only on an internal Docker network. Only the API and Web canary ports bind
  to `127.0.0.1`; databases and workers have no host port.
- The existing public service is not displaced by an automated canary. Public
  Caddy activation is an explicit, human-reviewed cutover after loopback
  evidence is green.

The current Vultr size is intentionally checked before every release: Linux
amd64, at least 1500 MiB RAM, 2 GiB swap, and 8 GiB free below `/opt`. A failed
resource check stops before pulling or changing a container.

## One-time host provisioning

Install Docker Engine with Compose v2, `curl`, and OpenSSL from trusted,
pinned distribution packages. The deployment workflow idempotently installs
Ubuntu's security-supported `age` package and exercises a digest-pinned official
Cosign container before release verification; no mutable Cosign host package is
trusted. Configure a persistent,
read-only GHCR credential in the root Docker credential store. Host preflight
requires that credential before any pull. The workflow's GitHub token is used
only on its ephemeral runner and is never sent to Vultr. Do not pass a registry
token in a runtime Compose environment.

Create the persistent configuration and secret tree without printing values:

```bash
ssh botmem
install -d -m 0750 /opt/botmem-v2
cp /opt/botmem-v2/releases/<commit>/deploy/vps/config.env.example /opt/botmem-v2/config.env
chmod 0600 /opt/botmem-v2/config.env
/opt/botmem-v2/releases/<commit>/deploy/vps/init-secrets.sh /opt/botmem-v2/secrets
```

`init-secrets.sh` creates the internal CA, service certificates, independent
database role passwords, session pepper, connector vault key, lifecycle
artifact key, and TLS URLs. It creates empty provider/commerce/backup files;
provision those files from their respective consoles before deployment. The
backup identity and recipient are an `age` key pair. Keep a second copy of the
identity in the company recovery vault, separate from Vultr.

Run initialization as root. Standalone Compose mounts file secrets directly,
so the initializer gives only runtime-mounted files uid 1000 and mode 0400;
private CA, backup, and administrator material stays root-owned. When provider
secrets are later written, retain uid 1000 and mode 0400. The verifier rejects
a runtime secret that the non-root process could not read.

Run `verify-secrets.sh` after provisioning. It rejects empty files, symlinks,
loose permissions, malformed encryption keys, a mismatched backup key, and TLS
certificates whose SAN does not match `postgres` or `redis`.

The role bootstrap is idempotent. It creates NOLOGIN boundary roles from
`db/bootstrap/00_roles.sql` and these NOINHERIT logins:

| Login                            | Only allowed role       |
| -------------------------------- | ----------------------- |
| `botmem_v2_api_login`            | `botmem_api`            |
| `botmem_v2_sync_login`           | `botmem_worker`         |
| `botmem_v2_projection_login`     | `botmem_worker`         |
| `botmem_v2_dispatcher_login`     | `botmem_dispatcher`     |
| `botmem_v2_commerce_login`       | `botmem_commerce`       |
| `botmem_v2_identity_admin_login` | `botmem_identity_admin` |
| `botmem_v2_lifecycle_login`      | `botmem_lifecycle`      |
| `botmem_v2_migrator_login`       | `botmem_migrator`       |

The bootstrap revokes public database access, denies superuser/BYPASSRLS and
cross-boundary memberships, and verifies the role graph before the migration
runner starts. Every login, including the migration-only login, is NOINHERIT.
The one-shot Node/PostgreSQL migrator verifies the exact
`botmem_v2_migrator_login` → `botmem_migrator` → `botmem_schema_owner` chain,
explicitly sets the schema-owner role for DDL, and has no runtime-role path.
Its URL and password remain separate secret files. A session advisory lock
serializes concurrent deploys; ordered migration names and SHA-256 checksums
must match the immutable `botmem_migration.history` ledger exactly. Each SQL
migration and its ledger row commit in one transaction, so failed DDL rolls
back without advancing history. Gaps, out-of-order files, failed legacy rows,
database-ahead state, and checksum drift stop the deployment. A verified
existing `botmem.flyway_schema_history` prefix is imported once for upgrades;
the former table is retained read-only as audit evidence.

## Strict SSH trust

The production GitHub environment needs `BOTMEM_V2_SSH_HOST`,
`BOTMEM_V2_SSH_PORT`, `BOTMEM_V2_SSH_USER`, `BOTMEM_V2_SSH_PRIVATE_KEY`, and
`BOTMEM_V2_SSH_KNOWN_HOSTS`. Capture and verify the server host-key fingerprint
through the Vultr console or another already trusted channel. Store the exact
known-hosts line as the secret. Key rotation is an explicit reviewed change.

The workflow sets `StrictHostKeyChecking yes`, a dedicated known-hosts file,
`IdentitiesOnly yes`, and batch mode. It never discovers a key during a
deployment and never weakens host verification.

## Release flow

`.github/workflows/botmem-v2-ci.yml` tests TypeScript, Rust, Swift, real
PostgreSQL/Redis behavior, container vulnerabilities, and both stable and
canary Compose models. A main-branch build publishes multi-platform images by
commit SHA and keyless-signs each manifest digest.

`.github/workflows/botmem-v2-deploy.yml` runs only after a successful main CI
run when the repository variable `BOTMEM_V2_AUTO_DEPLOY_ENABLED` is exactly
`true` (or after an explicit production-environment dispatch). Leave the
variable absent until host configuration and every live provider gate are
ready; this prevents the first merge from attempting an incomplete production
deployment. It:

1. resolves all nine commit tags to immutable manifest digests;
2. verifies every signature against the exact main-branch CI workflow identity;
3. connects with the pinned host key and transfers only versioned assets plus
   the non-secret digest release file;
4. repeats signature verification on Vultr before any image runs;
5. validates host resources, secret files, TLS identities, and Compose;
6. starts the stable PostgreSQL/Redis boundary and verifies exact login roles;
7. creates an age-encrypted pre-migration dump and restores it into a disposable
   digest-pinned pgvector container, compares every Botmem table count, and runs
   every SQL invariant;
8. runs the forward-only, checksummed, transaction-safe migration image;
9. starts candidate workers, then a separate API/Web project on loopback-only
   canary ports against the stable backend;
10. requires API liveness/readiness, Web HTML, an authenticated session
    boundary, and the lifecycle route before replacing stable API/Web;
11. atomically records the new release only after the stable smoke passes.

The encrypted verified dump is copied back as a 30-day GitHub artifact. A
systemd timer repeats the encrypted dump plus disposable restore daily and
retains 30 days on Vultr. Independently, the scheduled
`botmem-v2-backup.yml` workflow runs the restore rehearsal every day and uploads
the ciphertext plus verified checksum off host, so backup durability does not
depend on a recent deployment. Its repository variable
`BOTMEM_V2_BACKUP_ENABLED` must remain `false` until the first promoted release
has completed a verified restore; enable it immediately after that gate.
PostgreSQL is the system of record; Redis
presence and rate-limit state is intentionally rebuilt, never restored.

Workspace deletion removes active hosted content and credentials, but already
created encrypted full-database backups expire on their 30-day retention
schedule rather than being rewritten. They are unavailable to the product and
may be opened only for documented disaster recovery. This retention boundary is
published in the product privacy page and must be included in legal review.

The same operations installer enables a two-minute stateless health-recovery
timer. It uses the active immutable release, shares an exclusive lock with the
deploy script, and recovers only API/Web/worker containers. It never restarts
PostgreSQL or Redis automatically. Inspect its bounded journal with:

```bash
ssh botmem systemctl status botmem-v2-health-recover.service
ssh botmem journalctl -u botmem-v2-health-recover.service --since=-1h
```

At public cutover, enable the scheduled GitHub public monitor described in
`observability.md`. Until that variable is enabled and a forced run is green,
public availability monitoring is not considered active.

## Rollback

The deploy script records the previous asset and release symlinks before it
changes a runtime. A pull, bootstrap, backup, restore, migration, readiness,
canary, or stable-smoke failure stops the candidate and recreates all runtime
services from the prior Compose file and prior signed digest release. The
database is not reverse-migrated: migrations must use expand/contract so the
prior application remains compatible.

For a destructive migration incident, stop writers, restore the last verified
encrypted dump into a new PostgreSQL volume, run all invariants, and only then
change the database endpoint. Never edit an applied migration, alter or delete
the immutable migration ledger, or attempt to hide a checksum change.

Manual rollback to a retained release uses the same verified path, not mutable
tags:

```bash
ssh botmem
COSIGN_CERTIFICATE_IDENTITY='https://github.com/<owner>/<repo>/.github/workflows/botmem-v2-ci.yml@refs/heads/main' \
  /opt/botmem-v2/releases/<commit>/deploy/vps/deploy.sh \
  /opt/botmem-v2 <commit> /opt/botmem-v2/releases/<commit>/release.env
```

## Public edge and paid-service gates

Loopback promotion does not claim that DNS, macOS signing/notarization, provider
OAuth review, Full Disk Access, live Stripe, transactional email, or legal
copy is approved. Those are human-verifiable release gates.

After all gates pass, stop the previous process bound to ports 80/443 during a
scheduled cutover and run the retained release with
`BOTMEM_V2_EDGE_CONFIRM=replace_public_botmem_edge` and `--activate-edge`.
Caddy then obtains public certificates and routes Web plus `/v2/*` and
`/health/*` to v2. If another process still owns the ports, activation fails and
the prior release is restored; the deployment never kills an unrelated
container automatically.

For Stripe activation, use separate restricted Checkout and reconciler keys.
The reconciler key needs canonical Checkout/subscription reads plus subscription
cancellation, and no other write capability. Configure the exact API version and
live Price, verify signed webhook intake and out-of-order replay, exercise Portal
cancellation, and complete one low-value live purchase/refund. Also request
workspace deletion for the live test customer and verify the Stripe subscription
is canceled before hosted erasure completes. Provider client secrets, webhook
secrets, API keys, email addresses, and customer identifiers must not appear in
evidence or logs.
