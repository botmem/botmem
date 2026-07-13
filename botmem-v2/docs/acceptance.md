# Release acceptance

No release is ready for human review until automated evidence is green and the
remaining Gatekeeper/TCC/provider steps are presented as a short, reproducible
human verification script.

## Functional gates

- Clean signup, recovery, subscription purchase/cancel, export, and deletion.
- Gmail and Outlook OAuth complete and incremental sync without injected
  accounts or fixture memories.
- OwnTracks rejects unsafe endpoints and syncs from a real HTTPS Basic endpoint.
- Signed Mac install, one-time Botmem device pairing, source consent, TCC
  preflight, and automatic incremental iMessage/WhatsApp Desktop indexing.
  WhatsApp Desktop owns its pairing/session; Botmem verifies and reads only its
  local user-owned store and never receives remote session credentials.
- One sentinel query returns hosted and local source results together.
- Web, CLI, and MCP return identical ordered result IDs and provenance.
- Offline, slow, revoked, restarted, and multi-device paths report correct lane
  state without suppressing healthy results.

## Reliability and security gates

- Event and outbox are atomic; crash injection at every worker boundary repairs
  without loss or duplicate projections.
- Mutable items create a new revision and update the active projection.
- Two concurrent connection or sync attempts result in one account and one
  active run.
- Two-user isolation tests cover HTTP, WebSocket, attachment, CLI, and MCP paths.
- No runtime process connects to PostgreSQL as a superuser or `BYPASSRLS` role.
- OAuth state is atomically consumed; account ownership is asserted in every
  mutation.
- OwnTracks SSRF tests cover redirects, DNS rebinding, IPv4/IPv6 loopback,
  link-local, private ranges, and cloud metadata addresses.
- Device identities are per-device and revocable; relay session credentials are
  short-lived, hashed server-side, generation-bound, and rate-limited. Local
  identity replacement requires explicit deletion and re-pairing.
- Automated log inspection finds no credentials, queries, message contents,
  participant identifiers, or attachment bodies.
- Published privacy, pricing, recovery, and deletion claims match executable
  behavior.
- Stripe webhook intake verifies the exact raw body, commits a reduced envelope,
  and returns 2xx without waiting for Stripe reads or provisioning. Duplicate,
  reordered, retried, crashed, and dead-letter paths are exercised against real
  PostgreSQL with separate commerce and identity-admin logins.
- `checkout.session.completed`, asynchronous payment success/failure,
  subscription lifecycle, `invoice.paid`, and `invoice.payment_failed` all
  reconcile from current Stripe state. Only the fixed configured price at
  quantity one with `active` or `trialing` status grants product access.
- Workspace deletion is not claimable until Stripe cancellation is durably
  confirmed or no subscription exists. Provider outages retain a reason-only,
  bounded-backoff retry without exhausting the deletion attempt budget; offline
  Mac deletion notices remain best effort.

## Search gates

- Fixed multilingual corpus covers all five sources and durable deduplication.
- Hosted retrieval covers Arabic/English exact and prefix matching, typo
  recovery, and semantic paraphrases with no lexical overlap. Device-local
  retrieval covers Arabic/English exact, prefix, and typo recovery without
  shipping a model or local corpus to a hosted embedding provider.
- Source, time, people, account, and device filters behave identically by lane.
- The configured embedding dimension has a validated ANN index; a semantic match
  with no lexical overlap is retrievable.
- At 100,000 documents per hosted user and per device:
  - hosted p95 <= 500 ms;
  - local p95 <= 750 ms;
  - federated p95 <= 1.5 s and p99 <= 3 s.
- A lane exceeding its deadline cannot delay the whole request beyond the
  federated budget.

## Mac and release gates

- Universal macOS artifact with pinned supported deployment target.
- Successful GUI and CLI enrollment register launch-at-login by default. A
  cold app process launched after login reuses the persisted Keychain identity,
  starts the tunnel, and resumes incremental sync without another setup payload.
- Developer ID signature, hardened runtime, notarization, stapling, and
  Gatekeeper acceptance verified from the final downloadable artifact.
- Release fails closed when any signing/notarization credential or validation
  step is absent.
- Rust format, Clippy, unit/integration, Swift/Rust link, TCC state, index
  generation, crash restart, clean quit, upgrade, and rollback tests pass.
- Installing the current signed DMG over the previous supported version preserves
  the device-only Keychain identity and last good index. The signed-DMG rollback
  procedure is documented and exercised. V2 does not claim an automatic updater.
- Human clean-Mac evidence must still record Gatekeeper first launch, any macOS
  login-item approval, an actual logout/reboot auto-start, real Full Disk Access,
  and signed previous-version upgrade/rollback. Unit/process tests do not claim
  those OS-owned dialogs or lifecycle events occurred.

The real helper/process gate is reproducible before the clean-machine run:

```bash
BOTMEM_V2_DEVICE_TEST_DATABASE_URL='postgresql://botmem:botmem@127.0.0.1:5432/botmem_v2_device_test' \
BOTMEM_V2_DEVICE_TEST_REDIS_URL='redis://127.0.0.1:6379' \
./scripts/device-process-canary.sh
```

## Production canary

From a clean production-like account:

1. Connect every launch source through its real setup path.
2. Wait for explicit ready/synced states.
3. Search a seeded sentinel from Web, CLI, and MCP.
4. Confirm matching ordered IDs, provenance, and no server persistence of local
   corpus rows.
5. Disconnect a device and repeat; hosted results remain with `partial: true`.
6. Reconnect/restart and confirm the next local message appears incrementally.
7. Export, cancel, and delete the account; verify storage and credential removal.
