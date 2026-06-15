import { useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/shallow';
import type { ConnectorAccount, ConnectorManifest, SyncSchedule } from '@botmem/shared';
import { cn, formatRelative, CONNECTOR_COLORS } from '@botmem/shared';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { useMemoryBankStore } from '../../store/memoryBankStore';
import { useConnectorStore } from '../../store/connectorStore';
import { useJobStore } from '../../store/jobStore';
import { accountStatusView } from '../../lib/accountStatus';
import { api } from '../../lib/api';

const BRIDGE_STATUS_POLL_MS = 10_000;

interface BridgeLiveStatus {
  connected: boolean;
  sources: { contacts: boolean; imessages: boolean } | null;
}

/**
 * Polls the per-account bridge status for live (apple/imessage) connectors.
 * Returns null until the first response, so callers can fall back to the
 * account's stored status while the first poll is in flight.
 */
function useBridgeLiveStatus(accountId: string, enabled: boolean): BridgeLiveStatus | null {
  const [status, setStatus] = useState<BridgeLiveStatus | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!enabled) {
      setStatus(null);
      return;
    }
    let timer: ReturnType<typeof setInterval> | null = null;
    const poll = async () => {
      try {
        const data = await api.getBridgeStatus(accountId);
        if (mounted.current) {
          setStatus({ connected: data.connected, sources: data.sources });
        }
      } catch {
        // Transient failures keep the last-known status; the next tick retries.
      }
    };
    void poll();
    timer = setInterval(() => void poll(), BRIDGE_STATUS_POLL_MS);
    return () => {
      if (timer !== null) clearInterval(timer);
    };
  }, [accountId, enabled]);

  return status;
}

const SCHEDULE_OPTIONS: Array<{ value: SyncSchedule; label: string }> = [
  { value: 'hourly', label: 'HOURLY' },
  { value: 'every-6h', label: 'EVERY 6H' },
  { value: 'daily', label: 'DAILY' },
  { value: 'manual', label: 'MANUAL' },
];

function actionLabel(account: ConnectorAccount, authType?: string): string {
  const action = account.syncHealth?.recoveryAction;
  if (action === 'rescan_qr' || authType === 'qr-code') return 'RE-SCAN QR';
  if (
    action === 'start_bridge' ||
    ((account.type === 'apple' || account.type === 'imessage') &&
      (account.status === 'disconnected' || account.status === 'reconnect_required'))
  ) {
    return 'RECONNECT BRIDGE';
  }
  if (action === 'reconnect') return 'RECONNECT';
  return 'EDIT';
}

const APPLE_BRIDGE_REMEDIATION =
  'Start the Botmem Apple bridge from connector setup, then run `botmem sync';

function appleBridgeError(account: ConnectorAccount) {
  if (
    !(account.type === 'apple' || account.type === 'imessage') ||
    account.status !== 'failed' ||
    !account.lastError
  ) {
    return account.lastError;
  }
  const idx = account.lastError.indexOf(APPLE_BRIDGE_REMEDIATION);
  return idx === -1 ? account.lastError : account.lastError.slice(0, idx).trim();
}

interface ConnectorAccountRowProps {
  account: ConnectorAccount;
  authType?: string;
  onRemove: (id: string) => void;
  onSyncNow: (id: string, memoryBankId?: string) => void;
  onEdit?: (id: string) => void;
  syncConfig?: ConnectorManifest['sync'];
}

export function ConnectorAccountRow({
  account,
  authType,
  onRemove,
  onSyncNow,
  onEdit,
  syncConfig,
}: ConnectorAccountRowProps) {
  const { memoryBanks, activeMemoryBankId } = useMemoryBankStore();
  const jobs = useJobStore(useShallow((s) => s.jobs.filter((job) => job.accountId === account.id)));
  const logs = useJobStore(useShallow((s) => s.logsByAccount[account.id] || []));
  const fetchLogs = useJobStore((s) => s.fetchLogs);
  const defaultBankId = activeMemoryBankId || memoryBanks.find((b) => b.isDefault)?.id;
  const [selectedBankId, setSelectedBankId] = useState(defaultBankId);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const status = accountStatusView(account, jobs);
  const isBridge = account.type === 'apple' || account.type === 'imessage';
  const bridgeLive = useBridgeLiveStatus(account.id, isBridge);
  // Live bridge truth: prefer the polled status; fall back to stored status while
  // the first poll is in flight (connected status => online).
  const bridgeOnline = bridgeLive
    ? bridgeLive.connected
    : isBridge && account.status === 'connected';
  const bridgeSources = bridgeLive?.sources ?? null;
  const latestJob = jobs[0];
  const reconnectIssue =
    status.status === 'bridge_offline' ||
    account.status === 'disconnected' ||
    account.status === 'reconnect_required';
  const errorPrefix =
    status.status === 'sync_failed'
      ? 'Sync failed: '
      : status.status === 'bridge_offline'
        ? 'Bridge offline: '
        : reconnectIssue
          ? 'Reconnect required: '
          : 'Warning: ';
  const showBankSelector = memoryBanks.length > 1;
  const scheduleConfig = {
    defaultSchedule: syncConfig?.defaultSchedule ?? 'daily',
    configurable: syncConfig?.configurable ?? true,
  };
  const usesManagedSync = !scheduleConfig.configurable;

  return (
    <div className="border-3 border-nb-border bg-nb-surface">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between p-3 gap-2">
        <div className="flex items-center gap-3">
          <div
            className="size-3 border-2 border-nb-border shrink-0"
            style={{ backgroundColor: CONNECTOR_COLORS[account.type] }}
          />
          <div className="min-w-0">
            <p className="font-mono text-sm font-bold text-nb-text truncate">
              {account.identifier}
            </p>
            {isBridge ? (
              <p className="font-mono text-xs text-nb-muted flex items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className={cn(
                    'inline-block size-2 border border-nb-border shrink-0',
                    bridgeOnline ? 'bg-nb-green' : 'bg-nb-orange',
                  )}
                />
                <span
                  className={cn(
                    'font-bold uppercase',
                    bridgeOnline ? 'text-nb-green' : 'text-nb-orange',
                  )}
                >
                  {bridgeOnline ? 'ONLINE' : 'OFFLINE'}
                </span>{' '}
                • {account.memoriesIngested} memories
                {bridgeSources && (bridgeSources.imessages || bridgeSources.contacts) && (
                  <>
                    {' '}
                    •{' '}
                    {[bridgeSources.imessages && 'iMessages', bridgeSources.contacts && 'Contacts']
                      .filter(Boolean)
                      .join(', ')}
                  </>
                )}
              </p>
            ) : (
              <p className="font-mono text-xs text-nb-muted">
                {account.lastSync ? `Synced ${formatRelative(account.lastSync)}` : 'Never synced'} •{' '}
                {account.memoriesIngested} memories
                {(account.contactsCount > 0 || account.groupsCount > 0) && (
                  <>
                    {' '}
                    • {account.contactsCount > 0 && `${account.contactsCount} people`}
                    {account.contactsCount > 0 && account.groupsCount > 0 && ', '}
                    {account.groupsCount > 0 && `${account.groupsCount} groups`}
                  </>
                )}
              </p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Badge color={status.color}>{status.label}</Badge>
          {status.progressText && (
            <span className="font-mono text-xs uppercase text-nb-muted">{status.progressText}</span>
          )}
          {!status.progressText &&
            (account.status === 'syncing' || account.status === 'queued') &&
            account.syncHealth && (
              <span className="font-mono text-xs uppercase text-nb-muted">
                {account.syncHealth.phase || status.label}
                {account.syncHealth.total && account.syncHealth.total > 0
                  ? ` ${account.syncHealth.progress ?? 0}/${account.syncHealth.total}`
                  : ''}
              </span>
            )}
          {showBankSelector && (
            <select
              id="sync-memory-bank"
              name="sync-memory-bank"
              value={selectedBankId || ''}
              onChange={(e) => setSelectedBankId(e.target.value || undefined)}
              aria-label="Select memory bank"
              className="appearance-none border-2 border-nb-border bg-nb-surface font-mono text-xs uppercase text-nb-text px-2 py-1.5 focus:outline-none focus:border-nb-lime cursor-pointer"
            >
              {memoryBanks.map((bank) => (
                <option key={bank.id} value={bank.id}>
                  {bank.name}
                  {bank.isDefault ? ' (default)' : ''}
                </option>
              ))}
            </select>
          )}
          {(['error', 'disconnected', 'reconnect_required', 'failed'] as string[]).includes(
            account.status,
          ) &&
            onEdit && (
              <Button
                size="sm"
                variant={
                  status.status === 'bridge_offline' || account.status === 'reconnect_required'
                    ? 'primary'
                    : 'danger'
                }
                onClick={() => onEdit(account.id)}
              >
                {actionLabel(account, authType)}
              </Button>
            )}
          {/* Bridge connectors (apple/imessage) are live-only: no schedule, no manual sync. */}
          {!isBridge &&
            (usesManagedSync ? (
              <span className="border-2 border-nb-border bg-nb-surface px-2 py-1.5 font-mono text-xs uppercase text-nb-muted">
                REALTIME
              </span>
            ) : (
              <select
                id="sync-schedule"
                name="sync-schedule"
                value={account.schedule}
                onChange={(e) =>
                  useConnectorStore
                    .getState()
                    .updateSchedule(account.id, e.target.value as SyncSchedule)
                }
                aria-label="Select sync schedule"
                className="appearance-none border-2 border-nb-border bg-nb-surface font-mono text-xs uppercase text-nb-text px-2 py-1.5 focus:outline-none focus:border-nb-lime cursor-pointer"
              >
                {SCHEDULE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            ))}
          {!isBridge && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => onSyncNow(account.id, selectedBankId)}
            >
              SYNC
            </Button>
          )}
          {confirmDelete ? (
            <>
              <Button
                size="sm"
                variant="danger"
                onClick={() => {
                  onRemove(account.id);
                  setConfirmDelete(false);
                }}
              >
                CONFIRM
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setConfirmDelete(false)}>
                CANCEL
              </Button>
            </>
          ) : (
            <Button size="sm" variant="danger" onClick={() => setConfirmDelete(true)}>
              X
            </Button>
          )}
        </div>
      </div>
      {jobs.length > 0 && (
        <div className="border-t-3 border-nb-border px-3 py-2 bg-nb-surface-muted">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
            <div className="font-mono text-xs uppercase text-nb-muted">
              LAST JOB {latestJob?.status}
              {latestJob?.total ? ` ${latestJob.progress}/${latestJob.total}` : ''}
              {latestJob?.error ? ` - ${latestJob.error}` : ''}
            </div>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                const next = !showLogs;
                setShowLogs(next);
                if (next) void fetchLogs(account.id, latestJob?.id);
              }}
            >
              {showLogs ? 'HIDE LOGS' : 'VIEW LOGS'}
            </Button>
          </div>
          {showLogs && (
            <div className="mt-2 border-2 border-nb-border bg-nb-bg max-h-48 overflow-auto">
              {logs.length > 0 ? (
                logs.map((log) => (
                  <div
                    key={log.id}
                    className="border-b border-nb-border/50 px-2 py-1 font-mono text-[11px] text-nb-text last:border-b-0"
                  >
                    <span className="uppercase text-nb-muted">{log.level}</span> {log.message}
                  </div>
                ))
              ) : (
                <div className="px-2 py-1 font-mono text-[11px] uppercase text-nb-muted">
                  NO LOGS
                </div>
              )}
            </div>
          )}
        </div>
      )}
      {account.lastError && (
        <div
          className={cn(
            'border-t-3 border-nb-border px-3 py-2',
            status.status === 'sync_failed'
              ? 'bg-red-950/30'
              : reconnectIssue
                ? 'bg-orange-950/30'
                : 'bg-yellow-950/30',
          )}
        >
          <p
            className={cn(
              'font-mono text-xs',
              status.status === 'sync_failed'
                ? 'text-nb-red'
                : reconnectIssue
                  ? 'text-orange-400'
                  : 'text-yellow-400',
            )}
          >
            <span className="font-bold uppercase">{errorPrefix}</span>
            {appleBridgeError(account)}
            {(account.type === 'apple' || account.type === 'imessage') &&
              account.status === 'failed' && (
                <span className="block mt-1 text-nb-muted">
                  Start the Botmem Apple bridge from connector setup, then run `botmem sync{' '}
                  {account.id}`.
                </span>
              )}
          </p>
        </div>
      )}
    </div>
  );
}
