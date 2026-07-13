import {
  SourceStatusSchema,
  type Connector,
  type SearchHit,
  type SearchLaneCoverage,
  type SearchResponse,
  type SourceStatus,
  type PublicReleaseConfiguration,
} from '@botmem-v2/contracts';
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import type { BotmemWebClient } from './data-client.js';
import { ConnectionsWorkspace } from './ConnectionsWorkspace.js';
import { DevicePairingPanel } from './DevicePairingPanel.js';
import { BillingPanel } from './BillingPanel.js';
import { AccountWorkspace } from './AccountWorkspace.js';
import { unavailableReleaseConfiguration } from './mac-release.js';
import { OneShotTimer } from './one-shot-timer.js';
import { workspaceEntry, workspacePath, type WorkspaceView } from './workspace-route.js';
import { ThemeToggle } from './ThemeToggle.js';

const CONNECTORS: readonly Connector[] = ['gmail', 'outlook', 'owntracks', 'imessage', 'whatsapp'];

const CONNECTOR_LABELS: Readonly<Record<Connector, string>> = {
  gmail: 'Gmail',
  outlook: 'Outlook',
  owntracks: 'OwnTracks',
  imessage: 'iMessage',
  whatsapp: 'WhatsApp',
};

const RESULT_DATE_FORMATTER = new Intl.DateTimeFormat('en', {
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

const WORKSPACE_LABELS: Readonly<Record<WorkspaceView, string>> = {
  search: 'Search',
  connections: 'Connections',
  devices: 'Mac device',
  billing: 'Billing',
  account: 'Account',
};

interface AppProps {
  readonly client: BotmemWebClient;
  readonly workspaceId: string;
  readonly releases?: PublicReleaseConfiguration;
}

type SourceLoadState =
  | { readonly phase: 'loading' }
  | { readonly phase: 'error'; readonly message: string }
  | {
      readonly phase: 'ready';
      readonly sources: readonly SourceStatus[];
      readonly checkedAt: string;
      readonly staleMessage?: string;
    };

type SearchState =
  | { readonly phase: 'idle' }
  | { readonly phase: 'loading'; readonly query: string }
  | { readonly phase: 'error'; readonly message: string }
  | { readonly phase: 'success'; readonly response: SearchResponse };

export function App({
  client,
  workspaceId,
  releases = unavailableReleaseConfiguration(window.location.origin),
}: AppProps) {
  const entryRef = useRef<ReturnType<typeof workspaceEntry> | null>(null);
  entryRef.current ??= workspaceEntry(new URL(window.location.href));
  const entry = entryRef.current;
  const [view, setView] = useState<WorkspaceView>(entry.view);
  const [query, setQuery] = useState('');
  const [queryError, setQueryError] = useState<string>();
  const [selectedConnectors, setSelectedConnectors] = useState<readonly Connector[]>([]);
  const [searchState, setSearchState] = useState<SearchState>({ phase: 'idle' });
  const [sourceState, setSourceState] = useState<SourceLoadState>({ phase: 'loading' });
  const [sourceReload, setSourceReload] = useState(0);
  const searchRun = useRef(0);
  const initialWorkspaceFocus = useRef(true);

  useEffect(() => {
    const onPopState = () => setView(workspaceEntry(new URL(window.location.href)).view);
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    if (!entry.connectionNotice) return;
    window.history.replaceState(null, '', workspacePath('connections'));
  }, [entry.connectionNotice]);

  useEffect(() => {
    const viewLabel = WORKSPACE_LABELS[view];
    document.title =
      view === 'search' && searchState.phase === 'success'
        ? `Botmem — ${searchState.response.found} ${searchState.response.found === 1 ? 'result' : 'results'}`
        : `Botmem — ${viewLabel}`;
  }, [searchState, view]);

  useLayoutEffect(() => {
    if (initialWorkspaceFocus.current) {
      initialWorkspaceFocus.current = false;
      return;
    }
    document.getElementById('main-content')?.focus();
  }, [view]);

  useEffect(() => {
    let current = true;
    const timer = new OneShotTimer();
    let controller: AbortController | undefined;
    let failures = 0;
    setSourceState({ phase: 'loading' });
    const load = async (initial: boolean) => {
      controller?.abort();
      const requestController = new AbortController();
      controller = requestController;
      try {
        const sources = await client.listSourceStatuses(workspaceId, requestController.signal);
        if (!current || requestController.signal.aborted) return;
        failures = 0;
        setSourceState({
          phase: 'ready',
          sources: sources.map((source) => SourceStatusSchema.parse(source)),
          checkedAt: new Date().toISOString(),
        });
        schedule(sources.some((source) => !source.searchable) ? 3_000 : 10_000);
      } catch (error) {
        if (!current || requestController.signal.aborted) return;
        failures += 1;
        if (initial) {
          setSourceState({
            phase: 'error',
            message: error instanceof Error ? error.message : 'Source status request failed',
          });
        } else {
          const staleMessage =
            error instanceof Error ? error.message : 'Source status refresh failed';
          setSourceState((previous) =>
            previous.phase === 'ready' ? { ...previous, staleMessage } : previous,
          );
        }
        schedule(Math.min(60_000, 5_000 * 2 ** Math.min(4, failures - 1)));
      }
    };
    const schedule = (delay: number) => {
      if (!current) return;
      const hidden = document.visibilityState === 'hidden';
      timer.schedule(hidden ? Math.max(30_000, delay) : delay, () => void load(false));
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
      controller?.abort();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [client, sourceReload, workspaceId]);

  async function search(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const normalizedQuery = query.trim();
    if (!normalizedQuery) {
      setQueryError('Enter what you want to find.');
      return;
    }
    setQueryError(undefined);
    const run = searchRun.current + 1;
    searchRun.current = run;
    setSearchState({ phase: 'loading', query: normalizedQuery });
    try {
      const response = await client.search(workspaceId, {
        version: 2,
        query: normalizedQuery,
        ...(selectedConnectors.length > 0 ? { connectors: [...selectedConnectors] } : {}),
      });
      if (searchRun.current === run) setSearchState({ phase: 'success', response });
    } catch (error: unknown) {
      if (searchRun.current !== run) return;
      setSearchState({
        phase: 'error',
        message:
          error instanceof Error ? error.message : 'Search failed before any source could answer.',
      });
    }
  }

  function toggleConnector(connector: Connector): void {
    setSelectedConnectors((current) =>
      current.includes(connector)
        ? current.filter((item) => item !== connector)
        : [...current, connector],
    );
  }

  function selectView(nextView: WorkspaceView): void {
    if (nextView !== view) {
      window.history.pushState(null, '', workspacePath(nextView));
      // react-doctor-disable-next-line react-doctor/no-impure-state-updater -- This is a direct event-handler update, not a functional state updater callback.
      setView(nextView);
    }
  }

  return (
    <>
      <a className="skip-link" href="#main-content">
        Skip to workspace
      </a>
      <header className="site-header">
        <a className="wordmark" href="/" aria-label="Botmem home">
          BOTMEM<span aria-hidden="true">//</span>
          <small>V2</small>
        </a>
        <p className="header-statement">Your history. One evidence layer.</p>
        <ThemeToggle />
      </header>

      <p className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">
        {WORKSPACE_LABELS[view]} workspace
      </p>

      <nav className="view-switcher" aria-label="Workspace sections">
        <button
          type="button"
          aria-current={view === 'search' ? 'page' : undefined}
          onClick={() => selectView('search')}
        >
          Search
        </button>
        <button
          type="button"
          aria-current={view === 'connections' ? 'page' : undefined}
          onClick={() => selectView('connections')}
        >
          Connections
        </button>
        <button
          type="button"
          aria-current={view === 'devices' ? 'page' : undefined}
          onClick={() => selectView('devices')}
        >
          Mac device
        </button>
        <button
          type="button"
          aria-current={view === 'billing' ? 'page' : undefined}
          onClick={() => selectView('billing')}
        >
          Billing
        </button>
        <button
          type="button"
          aria-current={view === 'account' ? 'page' : undefined}
          onClick={() => selectView('account')}
        >
          Account
        </button>
      </nav>

      {view === 'search' ? (
        <div className="workspace-shell">
          <main id="main-content" className="search-workspace" tabIndex={-1}>
            <section className="search-intro" aria-labelledby="search-heading">
              <p className="eyebrow">UNIFIED RECALL / HOSTED + ON-DEVICE</p>
              <h1 id="search-heading">Find the thread.</h1>
              <p>
                Search every eligible source. If one cannot answer, Botmem says exactly which one.
              </p>
            </section>

            <form className="search-console" onSubmit={search} noValidate>
              <label htmlFor="memory-query">Search your memory</label>
              <div className="query-row">
                <span className="prompt-mark" aria-hidden="true">
                  ›
                </span>
                <input
                  id="memory-query"
                  type="search"
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    if (queryError) setQueryError(undefined);
                  }}
                  aria-describedby={queryError ? 'query-error' : 'query-hint'}
                  aria-invalid={Boolean(queryError)}
                  placeholder="meeting notes, a person, a place…"
                  autoComplete="off"
                />
                <button type="submit" disabled={searchState.phase === 'loading'}>
                  {searchState.phase === 'loading' ? 'Searching…' : 'Search memory'}
                </button>
              </div>
              {queryError ? (
                <p className="field-error" id="query-error" role="alert">
                  {queryError}
                </p>
              ) : (
                <p className="field-hint" id="query-hint">
                  Press Enter to search. No score is hidden.
                </p>
              )}

              <fieldset className="source-filter">
                <legend>Search scope</legend>
                <p>
                  {selectedConnectors.length === 0
                    ? 'All sources'
                    : `${selectedConnectors.length} selected`}
                </p>
                <div className="filter-options">
                  {CONNECTORS.map((connector) => (
                    <label key={connector} data-connector={connector}>
                      <input
                        type="checkbox"
                        checked={selectedConnectors.includes(connector)}
                        onChange={() => toggleConnector(connector)}
                      />
                      <span>{CONNECTOR_LABELS[connector]}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
            </form>

            <SearchOutput state={searchState} />
          </main>

          <SourceRail
            state={sourceState}
            onRetry={() => setSourceReload((current) => current + 1)}
          />
        </div>
      ) : view === 'connections' ? (
        <ConnectionsWorkspace
          client={client}
          workspaceId={workspaceId}
          {...(entry.connectionNotice ? { connectionNotice: entry.connectionNotice } : {})}
        />
      ) : view === 'devices' ? (
        <DevicePairingPanel client={client} workspaceId={workspaceId} macRelease={releases.macos} />
      ) : view === 'billing' ? (
        <BillingPanel client={client} workspaceId={workspaceId} />
      ) : (
        <AccountWorkspace client={client} workspaceId={workspaceId} releases={releases} />
      )}
      <footer className="site-footer">
        <span>LOCAL CONTENT STAYS LOCAL</span>
        <span>SEARCH CONTRACT / V2</span>
      </footer>
    </>
  );
}

function SearchOutput({ state }: { readonly state: SearchState }) {
  const completionHeading = useRef<HTMLHeadingElement>(null);
  const focusKey = state.phase === 'success' ? state.response.queryId : state.phase;

  useEffect(() => {
    if (state.phase !== 'success' && state.phase !== 'error') return;
    const frame = window.requestAnimationFrame(() => completionHeading.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [focusKey, state.phase]);

  if (state.phase === 'idle') {
    return (
      <section className="empty-state" aria-labelledby="empty-heading">
        <span aria-hidden="true">⌁</span>
        <div>
          <h2 id="empty-heading">Ask across the gaps.</h2>
          <p>Results will preserve source, device or account placement, rank, and lane coverage.</p>
        </div>
      </section>
    );
  }
  if (state.phase === 'loading') {
    return (
      <section className="loading-state" role="status" aria-live="polite">
        <span className="activity-mark" aria-hidden="true" />
        <div>
          <strong>Searching every eligible lane…</strong>
          <p>Query: “{state.query}”</p>
        </div>
      </section>
    );
  }
  if (state.phase === 'error') {
    return (
      <section className="error-state" role="alert">
        <p className="eyebrow">SEARCH DID NOT COMPLETE</p>
        <h2 ref={completionHeading} tabIndex={-1}>
          Nothing was guessed.
        </h2>
        <p>{state.message} Check the connection and search again.</p>
      </section>
    );
  }

  const failedLanes = state.response.coverage.lanes.filter((lane) => lane.status !== 'complete');
  return (
    <section className="result-stream" aria-labelledby="results-heading">
      <div className="result-summary" role="status" aria-live="polite" aria-atomic="true">
        <div>
          <p className="eyebrow">QUERY COMPLETE / {state.response.tookMs} MS</p>
          <h2 id="results-heading" ref={completionHeading} tabIndex={-1}>
            {state.response.found} {state.response.found === 1 ? 'memory' : 'memories'} found
          </h2>
        </div>
        <span>{state.response.coverage.lanes.length} lanes reported</span>
      </div>

      {state.response.coverage.partial && (
        <section className="coverage-warning" role="status" aria-live="polite">
          <div className="warning-mark" aria-hidden="true">
            !
          </div>
          <div>
            <h3>Search coverage is partial.</h3>
            <p>Healthy sources still answered. These lanes were incomplete or degraded:</p>
            <ul>
              {failedLanes.map((lane) => (
                <li key={lane.laneId}>
                  <strong>{lane.laneId}</strong>
                  <span>{laneStatusLabel(lane)}</span>
                  {lane.reasonCode && <code>{lane.reasonCode}</code>}
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}

      {state.response.items.length === 0 ? (
        <div className="no-results">
          <h3>No memories matched.</h3>
          <p>Try a broader phrase or clear a source filter. Every returned score would be shown.</p>
        </div>
      ) : (
        <ol className="result-list">
          {state.response.items.map((item, index) => (
            <li key={item.ref}>
              <ResultItem item={item} index={index} />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function ResultItem({ item, index }: { readonly item: SearchHit; readonly index: number }) {
  const headingId = `result-heading-${index}`;
  return (
    <article className="result-item" aria-labelledby={headingId}>
      <div className="rank-block" aria-label={`Rank ${item.ranking.rank}`}>
        <span>#</span>
        {String(item.ranking.rank).padStart(2, '0')}
      </div>
      <div className="result-body">
        <div className="result-provenance">
          <span className="connector-tag" data-connector={item.origin.connector}>
            {CONNECTOR_LABELS[item.origin.connector]}
          </span>
          <span>{item.origin.placement === 'device' ? 'ON DEVICE' : 'HOSTED'}</span>
          <span>{formatDate(item.occurredAt)}</span>
        </div>
        <h3 id={headingId}>{item.title ?? 'Untitled memory'}</h3>
        <p className="result-text">{item.text}</p>
        {item.participants.length > 0 && (
          <p className="participants">
            PEOPLE /{' '}
            {item.participants
              .slice(0, 4)
              .map((person) => person.displayName ?? person.durableId)
              .join(' · ')}
          </p>
        )}
        <dl className="result-evidence">
          <div>
            <dt>Score</dt>
            <dd>{formatScore(item.ranking.score)}</dd>
          </div>
          <div>
            <dt>Matched lanes</dt>
            <dd>{item.ranking.matchedLanes.join(' + ')}</dd>
          </div>
          <div>
            <dt>Citation</dt>
            <dd>
              <code>{item.citation}</code>
            </dd>
          </div>
        </dl>
      </div>
    </article>
  );
}

function SourceRail({
  state,
  onRetry,
}: {
  readonly state: SourceLoadState;
  readonly onRetry: () => void;
}) {
  return (
    <aside className="source-rail" aria-labelledby="source-heading">
      <div className="rail-header">
        <p className="eyebrow">SOURCE TRUTH</p>
        <h2 id="source-heading">Coverage rail</h2>
      </div>
      {state.phase === 'loading' && (
        <p className="rail-load" role="status">
          Reading verified source states…
        </p>
      )}
      {state.phase === 'error' && (
        <div className="rail-error" role="alert">
          <strong>Status unavailable</strong>
          <p>{state.message}</p>
          <button type="button" onClick={onRetry}>
            Retry source check
          </button>
        </div>
      )}
      {state.phase === 'ready' && (
        <>
          {state.staleMessage ? (
            <p className="source-stale" role="status">
              Last successful check {new Date(state.checkedAt).toLocaleTimeString()}. Refresh
              failed: {state.staleMessage}
            </p>
          ) : null}
          <ul className="source-list">
            {CONNECTORS.map((connector) => (
              <SourceRow
                key={connector}
                connector={connector}
                source={state.sources.find((candidate) => candidate.connector === connector)}
              />
            ))}
          </ul>
        </>
      )}
      <p className="rail-note">
        A device heartbeat means connected—not searchable. Ready requires a completed index and a
        successful probe.
      </p>
    </aside>
  );
}

function SourceRow({
  connector,
  source,
}: {
  readonly connector: Connector;
  readonly source: SourceStatus | undefined;
}) {
  const display = sourceDisplay(source);
  return (
    <li className="source-row" data-connector={connector}>
      <span className="source-sigil" aria-hidden="true" />
      <div>
        <strong>{CONNECTOR_LABELS[connector]}</strong>
        <span>{connector === 'imessage' || connector === 'whatsapp' ? 'DEVICE' : 'HOSTED'}</span>
      </div>
      <div className={`state-label state-${display.tone}`}>
        <strong>{display.label}</strong>
        <span>{display.detail}</span>
      </div>
    </li>
  );
}

function sourceDisplay(source: SourceStatus | undefined): {
  readonly label: string;
  readonly detail: string;
  readonly tone: 'good' | 'warn' | 'bad' | 'quiet';
} {
  if (!source) return { label: 'Not reported', detail: 'No API state', tone: 'quiet' };
  if (source.detail === 'permission_required' || source.readiness === 'locked') {
    return {
      label: 'Permission required',
      detail: source.reasonCode ?? 'Grant device access',
      tone: 'bad',
    };
  }
  if (
    source.readiness === 'ready' &&
    source.searchable &&
    source.checkpointAt &&
    source.lastProbeAt
  ) {
    return {
      label: 'Ready',
      detail: `${source.indexedCount ?? 0} indexed`,
      tone: 'good',
    };
  }
  if (source.readiness === 'indexing' || source.detail === 'indexing') {
    return {
      label: 'Indexing',
      detail: `${source.indexedCount ?? 0} indexed so far`,
      tone: 'warn',
    };
  }
  if (source.readiness === 'connected') {
    return {
      label: 'Connected · not searchable',
      detail: 'Waiting for index + probe',
      tone: 'warn',
    };
  }
  if (source.readiness === 'degraded') {
    return { label: 'Degraded', detail: source.reasonCode ?? 'Limited coverage', tone: 'warn' };
  }
  if (source.readiness === 'error') {
    return { label: 'Error', detail: source.reasonCode ?? 'Source check failed', tone: 'bad' };
  }
  const labels: Readonly<Record<SourceStatus['readiness'], string>> = {
    disconnected: 'Disconnected',
    authorizing: 'Authorizing',
    enrolling: 'Enrolling',
    connected: 'Connected · not searchable',
    indexing: 'Indexing',
    ready: 'Verification incomplete',
    locked: 'Permission required',
    degraded: 'Degraded',
    error: 'Error',
  };
  return {
    label: labels[source.readiness],
    detail: source.reasonCode ?? 'Not searchable',
    tone: 'quiet',
  };
}

function laneStatusLabel(lane: SearchLaneCoverage): string {
  const labels: Readonly<Record<SearchLaneCoverage['status'], string>> = {
    complete: 'Complete',
    degraded: 'Degraded',
    offline: 'Offline',
    permission_required: 'Permission required',
    indexing: 'Indexing',
    timed_out: 'Timed out',
    failed: 'Failed',
  };
  return labels[lane.status];
}

function formatScore(score: number): string {
  return `${(score * 100).toFixed(1)}%`;
}

function formatDate(value: string | null): string {
  if (!value) return 'TIME UNKNOWN';
  return RESULT_DATE_FORMATTER.format(new Date(value));
}
