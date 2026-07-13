# Botmem macOS device app

This is the only production process allowed to open protected local source databases. The SwiftUI UI and `botmem-device` CLI both submit the same versioned `DeviceCommand` values to one `DeviceControlService`. The CLI connects to the app over a mode-`0600` Unix socket; its executable does not link the Rust adapter and cannot open Messages/WhatsApp databases.

## Supported platform

- macOS 14.0 or newer.
- Release artifacts must contain both `arm64` and `x86_64` slices.
- The Rust protected-source/index core is statically linked into `Botmem.app`.
- The separately signed, bundled `botmem-tunnel` helper makes the outbound TLS connection and opens only the active local index in SQLite read-only/query-only mode. It cannot open protected source databases or mutate index state.
- App Sandbox is intentionally not enabled because it would prevent user-approved Full Disk Access from covering the protected databases. The release uses hardened runtime with an empty entitlement set and read-only Rust database handles.

## Development verification

```bash
../scripts/macos/test.sh
```

The build first compiles `rust-ffi` for the current architecture, checks the exported probe/sync ABI, and then runs the Swift unit and integration tests. Generated output stays under ignored `macos/.build/`.

Run the app from SwiftPM with `swift run --package-path . Botmem`. The packaged CLI is located at `Botmem.app/Contents/Resources/bin/botmem-device`; a distributor may offer a user-approved symlink into `~/.local/bin`, but the app must be running for commands to succeed.

The setup payload contains only the API URL, workspace ID, and a short-lived, single-use public pairing code. The CLI reads it only from standard input and sends it over the private app socket; it is consumed by the API and is not retained as a credential. The app generates a 256-bit Ed25519 signing key with CryptoKit and stores its raw private key in a non-synchronizing, device-only Keychain item with `AfterFirstUnlockThisDeviceOnly`. This implementation does not claim Secure Enclave backing: CryptoKit's Ed25519 key type has no Secure Enclave representation.

GUI and CLI share one explicit local erase command. **ERASE LOCAL BOTMEM DATA** stops the tunnel, disables the login item, deletes the Keychain device identity and local configuration, and removes only the direct `Botmem/index` derived-data directory. The CLI requires `botmem-device erase-local-data --confirm ERASE-LOCAL-BOTMEM-DATA`. Path-safety tests reject parent or basename escapes and prove a neighboring source fixture remains unchanged. Messages and WhatsApp source databases are never deleted or modified. A server revoke (including a workspace deletion notice) permanently stops the current helper instead of reconnecting, but it does not claim remote file erasure or acknowledgement; hosted deletion remains non-blocking when a Mac is offline.

## Full Disk Access

Enabling a source invokes the Rust adapter's real read-only SQLite open and schema probe. An open failure becomes `permission_required`; file existence alone is not treated as permission evidence. Botmem opens the Full Disk Access System Settings pane only after the user presses the corresponding UI button or runs `botmem-device permission open`. Granting access is an unavoidable human macOS gate. Source discovery and schema handling remain in Rust.

WhatsApp setup is deliberately not a second unofficial session stack. The user installs and pairs WhatsApp Desktop, which remains the sole owner of its session credential. **RUN PREFLIGHT** in the GUI and `botmem-device source whatsapp preflight` in the CLI execute the same Rust probe: the Desktop store must exist, its schema must be supported, Full Disk Access must permit a real open, and SQLite must report the handle as read-only. Botmem writes only its derived `Botmem/index` state.

## Background indexing

The signed app owns one incremental scheduler for both sources. It triggers at app launch, after wake, after an activation reprobe makes a source newly ready, and on a bounded 30-second poll. iMessage is due every two minutes and WhatsApp every five; failures use bounded 30-second-to-five-minute backoff. Concurrent launch/wake/timer triggers coalesce behind one flight. Schedule and attempt state are stored in the private configuration before a scan, while the Rust indexer stores the actual per-source high-water cursor in SQLite. Restart therefore resumes an incremental scan instead of rebuilding or creating a hot retry loop. Manual GUI and CLI sync/reconcile commands still use the same control service.

## Login and tunnel lifecycle

`SMAppService.mainApp` is the sole login-item implementation and its real status is displayed. Successful GUI or CLI enrollment registers launch-at-login by default before reporting setup complete; if macOS reports `requiresApproval`, the enrolled state is preserved and the UI reports the approval gate. At every later login the signed main app loads the existing configuration and device-only Keychain identity, starts the tunnel, and begins incremental scheduling without another setup payload. The same control-service path is covered by cold-process tests and both GUI and CLI enrollment. The tunnel manager owns one outbound child process, rejects duplicate starts, passes only bounded non-secret configuration over standard input, reconnects with bounded exponential delay after transient unexpected exit, stops reconnecting after a permanent server revoke, and terminates the child on stop or app quit. The helper requests challenge signatures from the app over a same-UID, mode-`0600` Unix socket; the private key never leaves the app. The API returns a short-lived session only after signed authentication over verified `wss` transport.

Build the deterministic Universal helper first:

```bash
../scripts/build-universal-tunnel.sh
```

The output is always `target/universal-apple-darwin/release/botmem-tunnel`. The release gate rejects any external helper override, copies this exact executable to `Contents/Helpers/botmem-tunnel`, signs it before the app, and the app accepts only that bundled path. It also installs the repository AGPL license as `Contents/Resources/LICENSE.txt` and a commit-pinned corresponding-source URL as `Contents/Resources/SOURCE-NOTICE.txt`; both files are verified before signing and hashed in the release evidence/SBOM. The real-process transport canary covers TLS trust and hostname failure, pairing/replay, signed authentication, local search, cancellation, reconnect, graceful termination, revocation, and absence of local sentinel content from PostgreSQL, Redis, and logs.

## Production release gate

The release script has no ad-hoc or unsigned fallback:

```bash
DEVELOPER_ID_APPLICATION='Developer ID Application: …' \
NOTARY_PROFILE='botmem-notary' \
BOTMEM_VERSION='1.0.0' \
BOTMEM_BUILD_NUMBER='1' \
../scripts/macos/release.sh
```

It fails unless the app, CLI, and bundled tunnel are Universal, the protected-source Rust symbols are statically linked into the app and absent from the CLI, a real Developer ID identity is installed, hardened-runtime signing succeeds, Apple accepts both the app and DMG for notarization, tickets staple and validate, and Gatekeeper accepts both artifacts. These checks cannot be claimed until real Apple credentials are supplied and the resulting DMG is tested on a clean Mac.

`release-preflight.json` is always written and the script exits nonzero when any signing, notarization-profile, architecture, version, or tunnel prerequisite is absent. A successful run also writes `release-verification.json` with the notarization, stapling, Gatekeeper, linkage, architecture, and DMG checksum results. Neither file contains credentials.

Sparkle is intentionally deferred. V2 ships as signed manual DMG replacement only; it does not claim background or automatic updates. Shipping an updater without a separately protected EdDSA feed key, signed feed, downgrade policy, and clean-Mac rollback test would weaken the release boundary. Release review must install the current signed DMG over the previous supported build, verify the Keychain identity and last-good index survive, then exercise the documented signed-DMG rollback before approval.

After installing the signed DMG on a clean Mac, the cold-process portion is repeatable with a fresh one-time setup payload stored in a mode-`0600` file:

```bash
BOTMEM_SETUP_PAYLOAD_FILE=/private/path/setup.txt \
  ../scripts/macos/cold-process-resume-smoke.sh
```

The smoke verifies the final app signature and Gatekeeper assessment, enrolls through the packaged CLI, requires the real `SMAppService` status to be `enabled`, quits the app, launches a new process, and proves the existing enrollment starts the service without setup again. A subsequent real logout or reboot and login is intentionally a separate human gate because automating it would terminate the release runner itself.
