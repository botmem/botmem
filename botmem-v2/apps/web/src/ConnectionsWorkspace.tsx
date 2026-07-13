import type { DeviceSummary, HostedConnection, HostedConnector } from '@botmem-v2/contracts';
import { useEffect, useState, type FormEvent } from 'react';
import type { BotmemWebClient } from './data-client.js';
import { OneShotTimer } from './one-shot-timer.js';
import type { ConnectionCallbackNotice } from './workspace-route.js';

interface ConnectionsWorkspaceProps {
  readonly client: BotmemWebClient;
  readonly workspaceId: string;
  readonly navigateExternal?: (url: string) => void;
  readonly connectionNotice?: ConnectionCallbackNotice;
}

type SetupState =
  | { readonly phase: 'loading' }
  | { readonly phase: 'error'; readonly message: string }
  | {
      readonly phase: 'ready';
      readonly connections: readonly HostedConnection[];
      readonly devices: readonly DeviceSummary[];
      readonly checkedAt: string;
      readonly staleMessage?: string;
      readonly connectionsError?: string;
      readonly devicesError?: string;
    };

export function ConnectionsWorkspace({
  client,
  workspaceId,
  navigateExternal = (url) => window.location.assign(url),
  connectionNotice,
}: ConnectionsWorkspaceProps) {
  const [state, setState] = useState<SetupState>({ phase: 'loading' });
  const [reload, setReload] = useState(0);
  const [pendingAction, setPendingAction] = useState<string>();
  const [actionError, setActionError] = useState<string>();

  useEffect(() => {
    let current = true;
    const timer = new OneShotTimer();
    let failures = 0;
    let generation = 0;
    const load = async (initial: boolean) => {
      const run = ++generation;
      if (initial) setState({ phase: 'loading' });
      try {
        const [connections, devices] = await Promise.allSettled([
          client.listConnections(workspaceId),
          client.listDevices(workspaceId),
        ]);
        if (!current || run !== generation) return;
        if (connections.status === 'rejected' && devices.status === 'rejected') {
          throw connections.reason;
        }
        failures = 0;
        setState({
          phase: 'ready',
          connections: connections.status === 'fulfilled' ? connections.value.items : [],
          devices: devices.status === 'fulfilled' ? devices.value.items : [],
          checkedAt: new Date().toISOString(),
          ...(connections.status === 'rejected'
            ? {
                connectionsError: errorMessage(
                  connections.reason,
                  'Hosted connection state is unavailable.',
                ),
              }
            : {}),
          ...(devices.status === 'rejected'
            ? { devicesError: errorMessage(devices.reason, 'Mac device state is unavailable.') }
            : {}),
        });
        const changing =
          connections.status === 'rejected' ||
          devices.status === 'rejected' ||
          (connections.status === 'fulfilled' &&
            connections.value.items.some(
              (connection) =>
                connection.state === 'authorizing' ||
                connection.state === 'syncing' ||
                !connection.source.searchable,
            )) ||
          (devices.status === 'fulfilled' &&
            devices.value.items.some(
              (device) =>
                device.state === 'online' && device.sources.some((source) => !source.searchable),
            ));
        schedule(changing ? 2_000 : 10_000);
      } catch (error) {
        if (!current || run !== generation) return;
        failures += 1;
        if (initial) {
          setState({
            phase: 'error',
            message: error instanceof Error ? error.message : 'Setup state request failed',
          });
        } else {
          const staleMessage =
            error instanceof Error ? error.message : 'Setup state refresh failed';
          setState((previous) =>
            previous.phase === 'ready' ? { ...previous, staleMessage } : previous,
          );
        }
        schedule(Math.min(60_000, 5_000 * 2 ** Math.min(4, failures - 1)));
      }
    };
    const schedule = (delay: number) => {
      if (!current) return;
      timer.schedule(
        document.visibilityState === 'hidden' ? Math.max(30_000, delay) : delay,
        () => void load(false),
      );
    };
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') return;
      timer.cancel();
      void load(false);
    };
    document.addEventListener('visibilitychange', onVisibility);
    void load(true);
    return () => {
      current = false;
      timer.cancel();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [client, reload, workspaceId]);

  async function beginOAuth(connector: 'gmail' | 'outlook'): Promise<void> {
    // react-doctor-disable-next-line react-doctor/no-impure-state-updater -- This is a direct event-handler update, not a functional state updater callback.
    setPendingAction(connector);
    setActionError(undefined);
    try {
      const response = await client.beginOAuthConnection(workspaceId, {
        version: 2,
        connector,
      });
      navigateExternal(response.authorizationUrl);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Authorization could not start');
    } finally {
      setPendingAction(undefined);
    }
  }

  async function act(connectionId: string, action: 'sync' | 'disconnect'): Promise<void> {
    const actionId = `${connectionId}:${action}`;
    setPendingAction(actionId);
    setActionError(undefined);
    try {
      await client.actOnConnection(workspaceId, connectionId, { version: 2, action });
      setReload((value) => value + 1);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Connection action failed');
    } finally {
      setPendingAction(undefined);
    }
  }

  async function connectOwnTracks(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const endpoint = String(form.get('endpoint') ?? '').trim();
    const username = String(form.get('username') ?? '');
    const password = String(form.get('password') ?? '');
    setPendingAction('owntracks');
    setActionError(undefined);
    try {
      await client.connectOwnTracks(workspaceId, {
        version: 2,
        endpoint,
        username,
        password,
      });
      formElement.reset();
      setReload((value) => value + 1);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'OwnTracks connection failed');
    } finally {
      setPendingAction(undefined);
    }
  }

  return (
    <main id="main-content" className="setup-workspace" tabIndex={-1}>
      <section className="setup-intro" aria-labelledby="setup-heading">
        <p className="eyebrow">FIVE SOURCES / TWO TRUST BOUNDARIES</p>
        <h1 id="setup-heading">Connect the evidence.</h1>
        <p>
          Remote accounts sync into your hosted workspace. Messages stay indexed on your Mac and
          cross the relay only when you search.
        </p>
      </section>

      {connectionNotice ? (
        <section className="connection-callback-notice" role="status">
          <strong>
            {connectionNotice.connector === 'gmail' ? 'Gmail' : 'Outlook'} authorization returned.
          </strong>
          <span>{connectionProgress(state, connectionNotice.connector)}</span>
        </section>
      ) : null}

      {state.phase === 'loading' && (
        <section className="loading-state" role="status">
          <span className="activity-mark" aria-hidden="true" />
          <strong>Reading connection truth…</strong>
        </section>
      )}
      {state.phase === 'error' && (
        <section className="error-state" role="alert">
          <h2>Setup state is unavailable.</h2>
          <p>{state.message}</p>
          <button type="button" onClick={() => setReload((value) => value + 1)}>
            Retry
          </button>
        </section>
      )}
      {actionError && (
        <p className="setup-action-error" role="alert">
          {actionError}
        </p>
      )}
      {state.phase === 'ready' && (
        <>
          {state.staleMessage ? (
            <p className="setup-action-error" role="status">
              Showing the check from {new Date(state.checkedAt).toLocaleTimeString()}. Refresh
              failed: {state.staleMessage}
            </p>
          ) : null}
          <section className="setup-section" aria-labelledby="remote-heading">
            <div className="setup-section-heading">
              <p className="eyebrow">REMOTE / ENCRYPTED CREDENTIALS</p>
              <h2 id="remote-heading">Hosted sources</h2>
            </div>
            {state.connectionsError ? (
              <p className="setup-action-error" role="status">
                {state.connectionsError}
              </p>
            ) : (
              <div className="connection-grid">
                {(['gmail', 'outlook'] as const).map((connector) => (
                  <OAuthConnectionCard
                    key={connector}
                    connector={connector}
                    connection={state.connections.find((item) => item.connector === connector)}
                    pendingAction={pendingAction}
                    onAuthorize={beginOAuth}
                    onAction={act}
                  />
                ))}
                <OwnTracksConnectionCard
                  connection={state.connections.find((item) => item.connector === 'owntracks')}
                  pendingAction={pendingAction}
                  onConnect={connectOwnTracks}
                  onAction={act}
                />
              </div>
            )}
          </section>

          <section className="setup-section" aria-labelledby="device-heading">
            <div className="setup-section-heading">
              <p className="eyebrow">LOCAL / OUTBOUND ONLY</p>
              <h2 id="device-heading">Mac devices</h2>
            </div>
            {state.devicesError ? (
              <p className="setup-action-error" role="status">
                {state.devicesError}
              </p>
            ) : state.devices.length === 0 ? (
              <div className="device-empty">
                <strong>No Mac is paired.</strong>
                <p>
                  Install the signed Botmem app, then use its setup screen or private CLI to pair
                  this workspace. Botmem cannot grant Full Disk Access for you.
                </p>
              </div>
            ) : (
              <ul className="device-list">
                {state.devices.map((device) => (
                  <DeviceRow key={device.deviceId} device={device} />
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </main>
  );
}

function OAuthConnectionCard({
  connector,
  connection,
  pendingAction,
  onAuthorize,
  onAction,
}: {
  readonly connector: 'gmail' | 'outlook';
  readonly connection: HostedConnection | undefined;
  readonly pendingAction: string | undefined;
  readonly onAuthorize: (connector: 'gmail' | 'outlook') => Promise<void>;
  readonly onAction: (connectionId: string, action: 'sync' | 'disconnect') => Promise<void>;
}) {
  const label = connector === 'gmail' ? 'Gmail' : 'Outlook';
  return (
    <article className="connection-card" data-connector={connector}>
      <ConnectionCardHeader connector={connector} label={label} connection={connection} />
      <p>
        {connector === 'gmail' ? 'Google OAuth / read-only mail' : 'Microsoft OAuth / Mail.Read'}
      </p>
      {connection?.failureCode && (
        <code className="connection-failure">{connection.failureCode}</code>
      )}
      {connection && connection.state !== 'revoked' && connection.state !== 'disconnected' ? (
        <ConnectionActions
          connection={connection}
          pendingAction={pendingAction}
          onAction={onAction}
        />
      ) : (
        <button
          type="button"
          disabled={pendingAction === connector}
          onClick={() => void onAuthorize(connector)}
        >
          {pendingAction === connector ? 'Opening authorization…' : `Connect ${label}`}
        </button>
      )}
    </article>
  );
}

function OwnTracksConnectionCard({
  connection,
  pendingAction,
  onConnect,
  onAction,
}: {
  readonly connection: HostedConnection | undefined;
  readonly pendingAction: string | undefined;
  readonly onConnect: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  readonly onAction: (connectionId: string, action: 'sync' | 'disconnect') => Promise<void>;
}) {
  const connected =
    connection && connection.state !== 'revoked' && connection.state !== 'disconnected';
  return (
    <article className="connection-card" data-connector="owntracks">
      <ConnectionCardHeader connector="owntracks" label="OwnTracks" connection={connection} />
      <p>HTTPS recorder / Basic authentication</p>
      {connection?.failureCode && (
        <code className="connection-failure">{connection.failureCode}</code>
      )}
      {connected ? (
        <ConnectionActions
          connection={connection}
          pendingAction={pendingAction}
          onAction={onAction}
        />
      ) : (
        <form className="owntracks-form" onSubmit={(event) => void onConnect(event)}>
          <label>
            Recorder URL
            <input
              name="endpoint"
              type="url"
              required
              placeholder="https://recorder.example.com/api/0/locations"
              aria-describedby="owntracks-endpoint-help"
            />
          </label>
          <small id="owntracks-endpoint-help">
            Use the exact public HTTPS endpoint ending in <code>/api/0/locations</code>.
          </small>
          <label>
            Username
            <input name="username" autoComplete="username" required />
          </label>
          <label>
            Password
            <input name="password" type="password" autoComplete="current-password" required />
          </label>
          <button type="submit" disabled={pendingAction === 'owntracks'}>
            {pendingAction === 'owntracks' ? 'Verifying recorder…' : 'Connect OwnTracks'}
          </button>
        </form>
      )}
    </article>
  );
}

function connectionProgress(state: SetupState, connector: 'gmail' | 'outlook'): string {
  if (state.phase !== 'ready') return 'Reading initial sync status…';
  if (state.connectionsError)
    return 'Authorization returned. Connection state is temporarily unavailable.';
  const connection = state.connections.find((item) => item.connector === connector);
  if (!connection) return 'Authorization succeeded. Waiting for the connection record…';
  if (connection.state === 'ready' && connection.source.searchable) {
    return 'Initial sync is ready for search.';
  }
  if (connection.failureCode) return `Initial sync needs attention: ${connection.failureCode}`;
  return 'Initial sync is running. This page refreshes automatically.';
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function ConnectionCardHeader({
  connector,
  label,
  connection,
}: {
  readonly connector: HostedConnector;
  readonly label: string;
  readonly connection: HostedConnection | undefined;
}) {
  return (
    <div className="connection-card-header">
      <span className="source-sigil" data-connector={connector} aria-hidden="true" />
      <div>
        <h3>{label}</h3>
        <span>{connection?.label ?? 'Not connected'}</span>
      </div>
      <strong data-state={connection?.state ?? 'disconnected'}>
        {connection?.state ?? 'disconnected'}
      </strong>
    </div>
  );
}

function ConnectionActions({
  connection,
  pendingAction,
  onAction,
}: {
  readonly connection: HostedConnection;
  readonly pendingAction: string | undefined;
  readonly onAction: (connectionId: string, action: 'sync' | 'disconnect') => Promise<void>;
}) {
  return (
    <div className="connection-actions">
      <button
        type="button"
        disabled={pendingAction === `${connection.id}:sync`}
        onClick={() => void onAction(connection.id, 'sync')}
      >
        {pendingAction === `${connection.id}:sync` ? 'Queueing sync…' : 'Sync now'}
      </button>
      <button
        className="danger-action"
        type="button"
        disabled={pendingAction === `${connection.id}:disconnect`}
        onClick={() => void onAction(connection.id, 'disconnect')}
      >
        Disconnect
      </button>
    </div>
  );
}

function DeviceRow({ device }: { readonly device: DeviceSummary }) {
  return (
    <li className="device-row">
      <div>
        <strong>{device.displayName}</strong>
        <span>
          {device.clientVersion ? `CLIENT ${device.clientVersion}` : 'CLIENT VERSION UNKNOWN'}
        </span>
      </div>
      <strong data-state={device.state}>{device.state}</strong>
      <ul>
        {device.connectors.map((connector) => {
          const source = device.sources.find((item) => item.connector === connector);
          return (
            <li key={connector} data-connector={connector}>
              <span>{connector === 'imessage' ? 'iMessage' : 'WhatsApp'}</span>
              <strong data-readiness={source?.readiness ?? 'not-reported'}>
                {source?.readiness ?? 'not reported'}
                {source?.reasonCode && <small>{source.reasonCode}</small>}
              </strong>
            </li>
          );
        })}
      </ul>
    </li>
  );
}
