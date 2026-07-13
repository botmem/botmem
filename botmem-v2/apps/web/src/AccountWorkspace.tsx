import type {
  LifecycleJob,
  PersonalAccessTokenMetadata,
  PersonalAccessTokenScope,
  PublicReleaseConfiguration,
} from '@botmem-v2/contracts';
import { useEffect, useState, type FormEvent } from 'react';
import type { BotmemWebClient } from './data-client.js';
import { unavailableReleaseConfiguration } from './mac-release.js';
import { OneShotTimer } from './one-shot-timer.js';

interface AccountWorkspaceProps {
  readonly client: BotmemWebClient;
  readonly workspaceId: string;
  readonly releases?: PublicReleaseConfiguration;
  readonly onSignedOut?: () => void;
  readonly confirmDeletion?: (message: string) => boolean;
}

interface AccountState {
  readonly tokens: readonly PersonalAccessTokenMetadata[];
  readonly jobs: readonly LifecycleJob[];
  readonly tokenError?: string;
  readonly jobError?: string;
}

// react-doctor-disable-next-line react-doctor/no-giant-component -- The account ledger is one security-sensitive workflow; extracting its tightly coupled action state is a separate architectural change.
export function AccountWorkspace({
  client,
  workspaceId,
  releases = unavailableReleaseConfiguration(window.location.origin),
  onSignedOut = () => window.location.assign('/'),
  confirmDeletion = (message) => window.confirm(message),
}: AccountWorkspaceProps) {
  const [state, setState] = useState<AccountState>();
  const [reload, setReload] = useState(0);
  const [action, setAction] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [issuedToken, setIssuedToken] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const expectedConfirmation = `DELETE ${workspaceId}`;

  useEffect(() => {
    let current = true;
    const refresh = new OneShotTimer();
    void Promise.allSettled([
      client.listPersonalAccessTokens(workspaceId),
      client.listLifecycleJobs(workspaceId),
    ]).then(([tokens, jobs]) => {
      if (!current) return;
      setState({
        tokens: tokens.status === 'fulfilled' ? tokens.value.items : [],
        jobs: jobs.status === 'fulfilled' ? jobs.value.items : [],
        ...(tokens.status === 'rejected'
          ? { tokenError: message(tokens.reason, 'Access-token state is unavailable.') }
          : {}),
        ...(jobs.status === 'rejected'
          ? { jobError: message(jobs.reason, 'Lifecycle state is unavailable.') }
          : {}),
      });
      if (
        jobs.status === 'fulfilled' &&
        jobs.value.items.some(
          (job) => job.state === 'queued' || job.state === 'running' || job.state === 'retry',
        )
      ) {
        refresh.schedule(2_000, () => setReload((value) => value + 1));
      }
    });
    return () => {
      current = false;
      refresh.cancel();
    };
  }, [client, reload, workspaceId]);

  async function issueToken(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const label = String(form.get('label') ?? '').trim();
    const scopes: PersonalAccessTokenScope[] = ['botmem:search'];
    if (form.has('connections-read')) scopes.push('botmem:connections:read');
    if (form.has('devices-read')) scopes.push('botmem:devices:read');
    setAction('issue-token');
    setActionError(undefined);
    setIssuedToken('');
    try {
      const issued = await client.issuePersonalAccessToken(workspaceId, {
        version: 2,
        label,
        ttlSeconds: 30 * 86_400,
        scopes,
      });
      setIssuedToken(issued.accessToken);
      formElement.reset();
      setReload((value) => value + 1);
    } catch (error) {
      setActionError(message(error, 'Access token could not be created.'));
    } finally {
      setAction(undefined);
    }
  }

  async function revokeToken(credentialId: string) {
    setAction(`revoke:${credentialId}`);
    setActionError(undefined);
    try {
      await client.revokePersonalAccessToken(workspaceId, credentialId);
      setReload((value) => value + 1);
    } catch (error) {
      setActionError(message(error, 'Access token could not be revoked.'));
    } finally {
      setAction(undefined);
    }
  }

  async function requestExport() {
    setAction('export');
    setActionError(undefined);
    try {
      await client.requestWorkspaceExport(workspaceId);
      setReload((value) => value + 1);
    } catch (error) {
      setActionError(message(error, 'Export could not be queued.'));
    } finally {
      setAction(undefined);
    }
  }

  async function downloadExport(job: LifecycleJob) {
    setAction(`download:${job.jobId}`);
    setActionError(undefined);
    try {
      const blob = await client.downloadWorkspaceExport(workspaceId, job.jobId);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `botmem-hosted-export-${workspaceId}.ndjson`;
      link.click();
      URL.revokeObjectURL(url);
      setReload((value) => value + 1);
    } catch (error) {
      setActionError(message(error, 'Export download failed.'));
    } finally {
      setAction(undefined);
    }
  }

  async function requestDeletion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      !confirmDeletion(
        'Delete this hosted workspace? Access is revoked immediately and this cannot be undone.',
      )
    )
      return;
    setAction('delete');
    setActionError(undefined);
    try {
      const response = await client.requestWorkspaceDeletion(workspaceId, confirmation);
      setState((current) =>
        current ? { ...current, jobs: [response.job, ...current.jobs] } : current,
      );
      setConfirmation('');
    } catch (error) {
      setActionError(message(error, 'Deletion could not be queued.'));
    } finally {
      setAction(undefined);
    }
  }

  async function signOut() {
    setAction('sign-out');
    setActionError(undefined);
    try {
      await client.signOut();
      onSignedOut();
    } catch (error) {
      setActionError(message(error, 'Sign out failed.'));
      setAction(undefined);
    }
  }

  return (
    <main id="main-content" className="account-workspace" tabIndex={-1}>
      <header className="account-intro">
        <p className="eyebrow">ACCOUNT / AGENT ACCESS / EXIT</p>
        <h1>Own the off-switch.</h1>
        <p>Issue narrow agent tokens, take a hosted export, or erase the workspace.</p>
        <code>{workspaceId}</code>
      </header>

      {!state ? (
        <p className="account-loading" role="status">
          Reading account truth…
        </p>
      ) : (
        <>
          {state.tokenError || state.jobError ? (
            <section className="account-load-error" role="alert">
              <strong>Some account state is unavailable.</strong>
              {state.tokenError ? <p>Agent tokens: {state.tokenError}</p> : null}
              {state.jobError ? <p>Lifecycle jobs: {state.jobError}</p> : null}
              <button type="button" onClick={() => setReload((value) => value + 1)}>
                Retry
              </button>
            </section>
          ) : null}
          <div className="account-ledger">
            <section
              className="account-section agent-access"
              aria-labelledby="agent-access-heading"
            >
              <div className="account-section-heading">
                <span>01</span>
                <div>
                  <h2 id="agent-access-heading">Agent access</h2>
                  <p>
                    CLI and MCP use revocable PATs. Search is required; status access is optional.
                  </p>
                </div>
              </div>
              <form className="token-issue-form" onSubmit={issueToken}>
                <label htmlFor="token-label">Token label</label>
                <input
                  id="token-label"
                  name="label"
                  required
                  maxLength={128}
                  placeholder="Personal MacBook / Claude MCP"
                />
                <fieldset className="token-scope-fieldset">
                  <legend>Read-only capabilities</legend>
                  <label>
                    <input type="checkbox" checked disabled />
                    <span>
                      <strong>Search</strong> Query indexed memory.
                    </span>
                  </label>
                  <label>
                    <input type="checkbox" name="connections-read" defaultChecked />
                    <span>
                      <strong>Connection status</strong> List hosted connector readiness.
                    </span>
                  </label>
                  <label>
                    <input type="checkbox" name="devices-read" defaultChecked />
                    <span>
                      <strong>Device status</strong> List paired Mac and local-source readiness.
                    </span>
                  </label>
                </fieldset>
                <button type="submit" disabled={action === 'issue-token'}>
                  {action === 'issue-token' ? 'Creating…' : 'Create 30-day token'}
                </button>
              </form>
              {issuedToken ? (
                <div className="issued-token" role="status">
                  <strong>Copy now. Botmem will not show this token again.</strong>
                  <textarea
                    aria-label="New personal access token"
                    readOnly
                    rows={3}
                    value={issuedToken}
                  />
                  <CopyButton
                    value={issuedToken}
                    idleLabel="Copy one-time token"
                    copiedLabel="Token copied"
                  />
                </div>
              ) : null}
              <AgentSetup workspaceId={workspaceId} releases={releases} />
              {state.tokenError ? (
                <p className="account-empty">
                  Active token list is unavailable. Existing tokens were not changed.
                </p>
              ) : state.tokens.length === 0 ? (
                <p className="account-empty">No active personal access tokens.</p>
              ) : (
                <ul className="token-list">
                  {state.tokens.map((token) => (
                    <li key={token.credentialId}>
                      <div>
                        <strong>{token.label}</strong>
                        <code>{token.tokenPrefix}…</code>
                        <span>{token.scopes.map(scopeLabel).join(' · ')}</span>
                        <span>Expires {new Date(token.expiresAt).toLocaleDateString()}</span>
                      </div>
                      <button
                        type="button"
                        className="danger-action"
                        disabled={action === `revoke:${token.credentialId}`}
                        onClick={() => void revokeToken(token.credentialId)}
                      >
                        {action === `revoke:${token.credentialId}` ? 'Revoking…' : 'Revoke'}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="account-section" aria-labelledby="export-heading">
              <div className="account-section-heading">
                <span>02</span>
                <div>
                  <h2 id="export-heading">Hosted export</h2>
                  <p>Encrypted, short-lived, one download. Local Mac content is excluded.</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => void requestExport()}
                disabled={action === 'export'}
              >
                {action === 'export' ? 'Queuing…' : 'Request export'}
              </button>
              {state.jobError ? (
                <p className="account-empty">
                  Export history is unavailable. New requests are still explicit.
                </p>
              ) : (
                <JobList
                  jobs={state.jobs.filter((job) => job.kind === 'export')}
                  action={action}
                  onDownload={downloadExport}
                />
              )}
            </section>

            <section className="account-section danger-zone" aria-labelledby="deletion-heading">
              <div className="account-section-heading">
                <span>03</span>
                <div>
                  <h2 id="deletion-heading">Delete workspace</h2>
                  <p>
                    Hosted deletion continues if Stripe is unavailable or a Mac is offline. Local
                    Mac data remains until you explicitly erase it on that Mac.
                  </p>
                </div>
              </div>
              <form className="deletion-form" onSubmit={requestDeletion}>
                <label htmlFor="deletion-confirmation">
                  Type <code>{expectedConfirmation}</code>
                </label>
                <input
                  id="deletion-confirmation"
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.target.value)}
                  autoComplete="off"
                />
                <button
                  type="submit"
                  className="danger-action"
                  disabled={confirmation !== expectedConfirmation || action === 'delete'}
                >
                  {action === 'delete' ? 'Queuing deletion…' : 'Delete this workspace'}
                </button>
              </form>
              {state.jobError ? (
                <p className="account-empty">
                  Deletion history is unavailable. Sign out remains available below.
                </p>
              ) : (
                <JobList
                  jobs={state.jobs.filter((job) => job.kind === 'deletion')}
                  action={action}
                />
              )}
            </section>

            <section className="account-section session-exit" aria-labelledby="session-heading">
              <div className="account-section-heading">
                <span>04</span>
                <div>
                  <h2 id="session-heading">This browser</h2>
                  <p>Revoke the current HttpOnly session and return to sign in.</p>
                </div>
              </div>
              <button type="button" onClick={() => void signOut()} disabled={action === 'sign-out'}>
                {action === 'sign-out' ? 'Signing out…' : 'Sign out'}
              </button>
            </section>
          </div>
        </>
      )}
      {actionError ? (
        <p className="account-action-error" role="alert">
          {actionError}
        </p>
      ) : null}
    </main>
  );
}

function AgentSetup({
  workspaceId,
  releases,
}: {
  readonly workspaceId: string;
  readonly releases: PublicReleaseConfiguration;
}) {
  const cliRelease = releases.cli;
  const mcpUrl = new URL(
    `/v2/workspaces/${encodeURIComponent(workspaceId)}/mcp`,
    releases.apiBaseUrl,
  ).toString();
  const cliCommands = [
    `export BOTMEM_API_URL='${new URL(releases.apiBaseUrl).origin}'`,
    "export BOTMEM_ACCESS_TOKEN='<paste the one-time PAT>'",
    `botmem search --workspace '${workspaceId}' --query 'launch notes' --json`,
  ].join('\n');
  const mcpConfiguration = JSON.stringify(
    {
      mcpServers: {
        botmem: {
          url: mcpUrl,
          headers: { Authorization: 'Bearer <paste the one-time PAT>' },
        },
      },
    },
    null,
    2,
  );

  return (
    <div className="agent-setup" aria-labelledby="agent-setup-heading">
      <div>
        <h3 id="agent-setup-heading">Connect your tools</h3>
        <p>
          These templates contain a placeholder, never your PAT. Paste the one-time secret only into
          your local environment or MCP client.
        </p>
      </div>
      {cliRelease.available ? (
        <div className="agent-setup-block">
          <label htmlFor="cli-install-command">
            Install verified CLI v{cliRelease.releaseVersion}
          </label>
          <textarea
            id="cli-install-command"
            readOnly
            rows={2}
            value={`npm install --global '${cliRelease.url}'`}
          />
          <code>SHA-256 {cliRelease.sha256}</code>
          <CopyButton
            value={`npm install --global '${cliRelease.url}'`}
            idleLabel="Copy install command"
            copiedLabel="Install command copied"
          />
        </div>
      ) : (
        <p className="agent-release-unavailable" role="status">
          The verified CLI download is temporarily unavailable. No mutable fallback is offered.
        </p>
      )}
      <div className="agent-setup-block">
        <label htmlFor="cli-setup-commands">CLI setup and first search</label>
        <textarea id="cli-setup-commands" readOnly rows={5} value={cliCommands} />
        <CopyButton
          value={cliCommands}
          idleLabel="Copy CLI commands"
          copiedLabel="CLI commands copied"
        />
      </div>
      <div className="agent-setup-block">
        <label htmlFor="mcp-client-config">MCP client config</label>
        <textarea id="mcp-client-config" readOnly rows={10} value={mcpConfiguration} />
        <code>{mcpUrl}</code>
        <CopyButton
          value={mcpConfiguration}
          idleLabel="Copy MCP config"
          copiedLabel="MCP config copied"
        />
      </div>
    </div>
  );
}

function CopyButton({
  value,
  idleLabel,
  copiedLabel,
}: {
  readonly value: string;
  readonly idleLabel: string;
  readonly copiedLabel: string;
}) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const copy = async () => {
    setCopyError(false);
    try {
      await navigator.clipboard.writeText(value);
      // react-doctor-disable-next-line react-doctor/no-impure-state-updater -- Direct event-handler state update; no functional updater or nested state mutation is used.
      setCopied(true);
    } catch {
      setCopyError(true);
    }
  };
  return (
    <>
      <button type="button" onClick={() => void copy()}>
        {copied ? copiedLabel : idleLabel}
      </button>
      {copyError ? (
        <span className="field-error" role="alert">
          Clipboard denied. Copy the text manually.
        </span>
      ) : null}
    </>
  );
}

function JobList({
  jobs,
  action,
  onDownload,
}: {
  readonly jobs: readonly LifecycleJob[];
  readonly action: string | undefined;
  readonly onDownload?: (job: LifecycleJob) => Promise<void>;
}) {
  if (jobs.length === 0) return <p className="account-empty">No requests yet.</p>;
  return (
    <ul className="job-list">
      {jobs.map((job) => (
        <li key={job.jobId}>
          <div>
            <strong>{job.state}</strong>
            <span>{new Date(job.requestedAt).toLocaleString()}</span>
            {job.failureCode ? <code>{job.failureCode}</code> : null}
          </div>
          {job.kind === 'export' && job.state === 'ready' && onDownload ? (
            <button
              type="button"
              disabled={action === `download:${job.jobId}`}
              onClick={() => void onDownload(job)}
            >
              {action === `download:${job.jobId}` ? 'Downloading…' : 'Download once'}
            </button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function message(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function scopeLabel(scope: PersonalAccessTokenScope): string {
  switch (scope) {
    case 'botmem:search':
      return 'Search';
    case 'botmem:connections:read':
      return 'Connections';
    case 'botmem:devices:read':
      return 'Devices';
  }
}
