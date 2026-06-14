import { useEffect, useState } from 'react';
import { cn, formatRelative } from '@botmem/shared';
import { PageContainer } from '../components/layout/PageContainer';
import { Card } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { useBridgeStore } from '../store/bridgeStore';
import type { LiveBridgeSource } from '../lib/api';

// PLACEHOLDER — the real run command is provided later. Surfaced verbatim so the
// user can copy it; obviously a placeholder until finalized.
const BRIDGE_RUN_COMMAND = 'npx @botmem/bridge start --pair';

const SOURCE_LABELS: Record<string, string> = {
  whatsapp: 'WhatsApp',
  imessage: 'iMessage',
  imessages: 'iMessage',
  contacts: 'Contacts',
};

function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source.charAt(0).toUpperCase() + source.slice(1);
}

function StatusDot({ online }: { online: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-block size-4 border-3 border-nb-border shrink-0',
        online ? 'bg-nb-green' : 'bg-nb-orange',
      )}
    />
  );
}

function CommandBlock() {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(BRIDGE_RUN_COMMAND);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard may be unavailable (insecure context); the text is still
      // visible and selectable below, so no fallback UI is needed.
    }
  };

  return (
    <div className="border-3 border-nb-border bg-nb-bg">
      <div className="flex items-center justify-between border-b-3 border-nb-border px-3 py-1.5">
        <span className="font-mono text-[11px] font-bold uppercase tracking-wider text-nb-muted">
          Run on your Mac
        </span>
        <button
          type="button"
          onClick={handleCopy}
          className={cn(
            'font-mono text-[11px] font-bold uppercase tracking-wider border-2 border-nb-border px-2 py-0.5 cursor-pointer',
            'hover:bg-nb-lime hover:text-black transition-colors',
            'focus-visible:outline-3 focus-visible:outline-nb-pink focus-visible:outline-offset-2',
            copied ? 'bg-nb-lime text-black' : 'text-nb-text',
          )}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="overflow-x-auto px-3 py-3">
        <code className="font-mono text-sm text-nb-text">
          <span className="text-nb-muted select-none">$ </span>
          {BRIDGE_RUN_COMMAND}
        </code>
      </pre>
    </div>
  );
}

function SourcesList({ sources }: { sources: LiveBridgeSource[] }) {
  if (sources.length === 0) {
    return (
      <p className="font-mono text-sm text-nb-muted">
        Connected, but no sources are being served yet.
      </p>
    );
  }

  return (
    <table className="w-full border-collapse">
      <caption className="sr-only">Sources served by the live bridge</caption>
      <thead>
        <tr className="border-b-3 border-nb-border text-left">
          <th
            scope="col"
            className="font-display text-[11px] font-bold uppercase tracking-wider text-nb-muted pb-2"
          >
            Source
          </th>
          <th
            scope="col"
            className="font-display text-[11px] font-bold uppercase tracking-wider text-nb-muted pb-2 text-right"
          >
            Indexed
          </th>
          <th
            scope="col"
            className="font-display text-[11px] font-bold uppercase tracking-wider text-nb-muted pb-2 text-right"
          >
            Last Indexed
          </th>
        </tr>
      </thead>
      <tbody>
        {sources.map((s) => (
          <tr key={s.source} className="border-b-2 border-nb-border/40">
            <td className="font-mono text-sm font-bold text-nb-text py-2">
              {sourceLabel(s.source)}
            </td>
            <td className="font-mono text-sm text-nb-text py-2 text-right tabular-nums">
              {s.count.toLocaleString()}
            </td>
            <td className="font-mono text-sm text-nb-muted py-2 text-right">
              {s.lastIndexedAt ? formatRelative(s.lastIndexedAt) : '—'}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function BridgePage() {
  const status = useBridgeStore((s) => s.status);
  const loading = useBridgeStore((s) => s.loading);
  const error = useBridgeStore((s) => s.error);
  const fetchStatus = useBridgeStore((s) => s.fetchStatus);
  const startPolling = useBridgeStore((s) => s.startPolling);
  const stopPolling = useBridgeStore((s) => s.stopPolling);

  useEffect(() => {
    startPolling();
    return () => stopPolling();
  }, [startPolling, stopPolling]);

  const online = status?.online ?? false;
  const flagEnabled = status?.flagEnabled ?? false;
  const sources = status?.sources ?? [];

  return (
    <PageContainer>
      <header className="mb-6">
        <h1 className="font-display text-2xl font-bold uppercase tracking-wider text-nb-text">
          Live Bridge
        </h1>
        <p className="font-mono text-sm text-nb-muted mt-1">
          Run search live on your Mac. When your bridge is online, queries hit your local data
          directly — nothing leaves your machine.
        </p>
      </header>

      {error && status === null ? (
        <Card className="mb-6">
          <p className="font-mono text-sm text-nb-red" role="alert">
            Couldn&apos;t load bridge status: {error}
          </p>
          <Button size="sm" variant="secondary" className="mt-3" onClick={() => void fetchStatus()}>
            Retry
          </Button>
        </Card>
      ) : loading && status === null ? (
        <Card className="mb-6">
          <p className="font-mono text-sm text-nb-muted">Checking bridge status…</p>
        </Card>
      ) : (
        <>
          {/* Status card */}
          <Card className="mb-6" color={online ? 'var(--color-nb-green)' : undefined}>
            <div className="flex items-center gap-3">
              <StatusDot online={online} />
              <span
                className="font-display text-3xl font-bold uppercase tracking-wider text-nb-text"
                aria-live="polite"
              >
                {online ? 'Online' : 'Offline'}
              </span>
            </div>
            <p className="font-mono text-sm text-nb-muted mt-2">
              {online
                ? 'Your Mac bridge is connected. Search runs live on your machine.'
                : 'Your Mac bridge is not connected. Start the bridge daemon below to go live.'}
            </p>
            {!flagEnabled && (
              <p className="font-mono text-xs text-nb-muted mt-3 border-l-3 border-nb-yellow pl-2">
                Live routing is currently disabled. Status is shown, but searches won&apos;t be
                routed to the bridge yet.
              </p>
            )}
          </Card>

          {/* Sources (online only) */}
          {online && (
            <Card className="mb-6">
              <h2 className="font-display text-sm font-bold uppercase tracking-wider text-nb-text mb-3">
                Sources Served
              </h2>
              <SourcesList sources={sources} />
            </Card>
          )}

          {/* Connect instructions */}
          <Card>
            <h2 className="font-display text-sm font-bold uppercase tracking-wider text-nb-text mb-3">
              Connect Your Mac
            </h2>
            <ol className="font-mono text-sm text-nb-text space-y-2 mb-4 list-decimal list-inside">
              <li>Open Terminal on the Mac that holds your messages.</li>
              <li>
                Run the command below to start the bridge daemon and pair it with your account.
              </li>
              <li>
                Keep the daemon running. This page flips to{' '}
                <span className="font-bold text-nb-green">ONLINE</span> automatically once it
                connects.
              </li>
            </ol>
            <CommandBlock />
          </Card>
        </>
      )}
    </PageContainer>
  );
}
