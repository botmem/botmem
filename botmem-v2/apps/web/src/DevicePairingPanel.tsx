import { useEffect, useState } from 'react';
import type { BotmemWebClient } from './data-client.js';
import type { MacReleaseArtifact } from '@botmem-v2/contracts';

interface DevicePairingPanelProps {
  readonly client: BotmemWebClient;
  readonly workspaceId: string;
  readonly macRelease: MacReleaseArtifact;
}

type PairingState =
  | { readonly phase: 'idle' }
  | { readonly phase: 'issuing' }
  | { readonly phase: 'ready'; readonly payload: string; readonly expiresAt: string }
  | { readonly phase: 'error'; readonly message: string };

/** Separate from commerce/connections so active checkout edits cannot overlap it. */
export function DevicePairingPanel({ client, workspaceId, macRelease }: DevicePairingPanelProps) {
  const [state, setState] = useState<PairingState>({ phase: 'idle' });
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string>();

  useEffect(() => {
    if (state.phase !== 'ready') return;
    const remaining = Date.parse(state.expiresAt) - Date.now();
    if (remaining <= 0) {
      setState({
        phase: 'error',
        message: 'The one-time setup payload expired. Generate a new one.',
      });
      return;
    }
    const timeout = setTimeout(
      () => {
        setState({
          phase: 'error',
          message: 'The one-time setup payload expired. Generate a new one.',
        });
      },
      Math.min(remaining, 2_147_483_647),
    );
    return () => clearTimeout(timeout);
  }, [state]);

  async function issue(): Promise<void> {
    setCopied(false);
    setCopyError(undefined);
    setState({ phase: 'issuing' });
    try {
      const setup = await client.issueDeviceSetup(workspaceId);
      setState({ phase: 'ready', ...setup });
    } catch (error) {
      setState({
        phase: 'error',
        message: error instanceof Error ? error.message : 'Pairing setup could not be issued.',
      });
    }
  }

  async function copy(): Promise<void> {
    if (state.phase !== 'ready') return;
    setCopyError(undefined);
    try {
      await navigator.clipboard.writeText(state.payload);
      setCopied(true);
    } catch {
      setCopyError('Clipboard access was denied. Select and copy the payload manually.');
    }
  }

  return (
    <main id="main-content" className="device-workspace" tabIndex={-1}>
      <section className="search-intro" aria-labelledby="device-heading">
        <p className="eyebrow">MAC DEVICE / LOCAL CONTENT STAYS LOCAL</p>
        <h1 id="device-heading">Install. Then pair.</h1>
        <p>Use the verified Mac release, then pair it with one short-lived setup payload.</p>
      </section>
      <section className="mac-release-card" aria-labelledby="mac-release-heading">
        <div>
          <p className="eyebrow">01 / SIGNED MAC APP</p>
          <h2 id="mac-release-heading">Get Botmem for macOS.</h2>
        </div>
        {macRelease.available ? (
          <>
            <a className="mac-download-action" href={macRelease.url}>
              Download signed DMG · v{macRelease.releaseVersion}
            </a>
            <p>
              Developer ID signed, notarized, and checked by macOS Gatekeeper before publication.
              Verify the downloaded file before opening it.
            </p>
            <dl className="release-fingerprint">
              <dt>SHA-256</dt>
              <dd>{macRelease.sha256}</dd>
            </dl>
          </>
        ) : (
          <p className="mac-release-unavailable" role="status">
            The verified Mac download is temporarily unavailable. Botmem does not offer an unsigned
            or mutable fallback.
          </p>
        )}
      </section>
      <section className="device-pairing-card">
        <div>
          <p className="eyebrow">02 / ONE-TIME PAIRING</p>
          <h2>Connect the installed app.</h2>
        </div>
        <button type="button" onClick={() => void issue()} disabled={state.phase === 'issuing'}>
          {state.phase === 'issuing' ? 'Issuing…' : 'Generate Mac setup'}
        </button>
        {state.phase === 'ready' && (
          <div className="device-setup-output">
            <label htmlFor="device-setup-payload">One-time setup payload</label>
            <textarea id="device-setup-payload" readOnly rows={7} value={state.payload} />
            <div>
              <button type="button" onClick={() => void copy()}>
                {copied ? 'Copied' : 'Copy setup payload'}
              </button>
              <span>Expires {new Date(state.expiresAt).toLocaleTimeString()}</span>
            </div>
            <p>This contains only the public API address, workspace ID, and single-use code.</p>
            {copyError ? (
              <p className="field-error" role="alert">
                {copyError}
              </p>
            ) : null}
          </div>
        )}
        {state.phase === 'error' && (
          <p className="field-error" role="alert">
            {state.message}
          </p>
        )}
      </section>
    </main>
  );
}
