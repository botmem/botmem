import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { ConnectorType } from '@botmem/shared';
import { cn, CONNECTOR_COLORS } from '@botmem/shared';
import { PageContainer } from '../components/layout/PageContainer';
import { Card } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { getConnectorGlyphClass, getConnectorIcon } from '../lib/connectorMeta';
import { ConnectorAccountRow } from '../components/connectors/ConnectorAccountRow';
import { ConnectorSetupModal } from '../components/connectors/ConnectorSetupModal';
import { connectorConfigs } from '../mock/connectors';
import { useConnectors } from '../hooks/useConnectors';
import { api } from '../lib/api';
import { sharedWs } from '../lib/ws';
import { useAuthStore } from '../store/authStore';
import { EmptyState } from '../components/ui/EmptyState';
import { formatAccountCount, getWorstAccountStatus } from '../components/connectors/accountDisplay';

const MAX_STATUS_POLLS = 60; // 5 minutes at 5s intervals
const CONNECTOR_ACCORDION_STORAGE_KEY = 'botmem.connectorAccordion';

function readExpandedConnectors() {
  if (typeof window === 'undefined') return new Set<string>();
  try {
    const value: unknown = JSON.parse(
      window.sessionStorage.getItem(CONNECTOR_ACCORDION_STORAGE_KEY) || '[]',
    );
    return new Set<string>(Array.isArray(value) ? value.filter((v) => typeof v === 'string') : []);
  } catch {
    return new Set<string>();
  }
}

function writeExpandedConnectors(expanded: Set<string>) {
  try {
    window.sessionStorage.setItem(CONNECTOR_ACCORDION_STORAGE_KEY, JSON.stringify([...expanded]));
  } catch {
    // Storage can be unavailable in privacy modes; in-memory state still works for this visit.
  }
}

function ConnectorStatusDot({ type }: { type: string }) {
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let polls = 0;
    const poll = () => {
      if (polls >= MAX_STATUS_POLLS) return;
      polls++;
      api
        .getConnectorStatus(type)
        .then((s) => {
          if (!active) return;
          setStatus(s.status);
          if (s.status !== 'qr_ready') setTimeout(poll, 5000);
        })
        .catch(() => {});
    };
    poll();
    return () => {
      active = false;
    };
  }, [type]);

  if (!status) return null;

  const color =
    status === 'qr_ready'
      ? 'bg-nb-green'
      : status === 'warming'
        ? 'bg-nb-yellow animate-pulse'
        : 'bg-nb-red';
  const label = status === 'qr_ready' ? 'Ready' : status === 'warming' ? 'Starting...' : 'Offline';

  return (
    <span className="inline-flex items-center gap-1 ml-2">
      <span className={cn('size-2 rounded-full', color)} />
      <span className="font-mono text-[11px] text-nb-muted uppercase">{label}</span>
    </span>
  );
}

export function ConnectorsPage() {
  const {
    accounts,
    manifests,
    removeAccount,
    syncNow,
    syncAll,
    syncingAll,
    fetchAccounts,
    error,
    clearError,
  } = useConnectors();
  const [searchParams, setSearchParams] = useSearchParams();
  const [oauthError, setOauthError] = useState<string | null>(null);

  // Handle OAuth callback redirect
  useEffect(() => {
    const error =
      searchParams.get('error') || (searchParams.get('auth') === 'error' ? 'error' : '');
    if (error) {
      setOauthError(searchParams.get('error_description') || error);
      setSearchParams({}, { replace: true });
      return;
    }
    if (searchParams.get('auth') === 'success') {
      setOauthError(null);
      fetchAccounts();
      setSearchParams({}, { replace: true });
    }
  }, [fetchAccounts, searchParams, setSearchParams]);

  // Subscribe to connector and job events so CLI-triggered syncs update this page too.
  const accessToken = useAuthStore((s) => s.accessToken);
  useEffect(() => {
    if (!accessToken) return;
    const handler = (msg: { event: string; channel?: string }) => {
      if (
        msg.event === 'connector:warning' ||
        msg.event === 'job:complete' ||
        (msg.channel === 'dashboard' && msg.event === 'dashboard:jobs')
      ) {
        fetchAccounts();
      }
    };
    sharedWs.subscribe('notifications', accessToken);
    sharedWs.subscribe('dashboard', accessToken);
    sharedWs.onMessage(handler);
    return () => {
      sharedWs.unsubscribe('notifications');
      sharedWs.unsubscribe('dashboard');
      sharedWs.offMessage(handler);
    };
  }, [fetchAccounts, accessToken]);
  const [expanded, setExpanded] = useState<Set<string>>(readExpandedConnectors);
  const [modalType, setModalType] = useState<ConnectorType | null>(null);
  const [editModal, setEditModal] = useState<{ type: ConnectorType; accountId: string } | null>(
    null,
  );

  // Use manifests from API if available, fall back to mock configs
  const displayConfigs =
    manifests.length > 0
      ? manifests.map((m) => ({
          type: m.id as ConnectorType,
          label: m.name,
          color: m.color,
          description: m.description,
        }))
      : connectorConfigs;

  const toggle = (type: string) => {
    const next = new Set(expanded);
    if (next.has(type)) next.delete(type);
    else next.add(type);
    // ponytail: per-tab state is enough; move to user prefs if accordion state must roam devices.
    writeExpandedConnectors(next);
    setExpanded(next);
  };

  return (
    <PageContainer>
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-6">
        <h2 className="font-display text-2xl sm:text-3xl font-bold uppercase text-nb-text">
          All Connectors
        </h2>
        {accounts.length > 0 && (
          <Button
            variant="primary"
            size="sm"
            disabled={syncingAll || accounts.every((a) => a.status === 'syncing')}
            onClick={() => syncAll()}
          >
            {syncingAll ? 'SYNCING...' : 'SYNC ALL'}
          </Button>
        )}
      </div>

      {(error || oauthError) && (
        <div className="border-3 border-nb-red bg-nb-red/10 p-3 mb-4 flex items-center justify-between">
          <span className="font-mono text-xs text-nb-text">{error || oauthError}</span>
          <button
            onClick={() => {
              clearError();
              setOauthError(null);
            }}
            className="font-mono text-xs text-nb-muted hover:text-nb-text cursor-pointer uppercase"
          >
            Dismiss
          </button>
        </div>
      )}

      <div className="flex flex-col gap-3" data-tour="connectors-grid">
        {displayConfigs.map((cfg) => {
          const typeAccounts = accounts.filter((a) => a.type === cfg.type);
          const isExpanded = expanded.has(cfg.type);
          const status = getWorstAccountStatus(typeAccounts);
          return (
            <Card key={cfg.type} className="p-0 overflow-hidden">
              <button
                onClick={() => toggle(cfg.type)}
                aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${cfg.label} connector`}
                aria-expanded={isExpanded}
                className={cn(
                  'w-full flex items-center justify-between p-4 cursor-pointer hover:bg-nb-surface-hover transition-colors text-nb-text',
                )}
              >
                <div className="flex items-center gap-3">
                  <div
                    className={cn(
                      'size-10 border-3 border-nb-border flex items-center justify-center text-lg font-bold',
                      getConnectorGlyphClass(cfg.type),
                    )}
                    style={{ backgroundColor: cfg.color || CONNECTOR_COLORS[cfg.type] }}
                  >
                    {getConnectorIcon(cfg.type)}
                  </div>
                  <div className="text-left">
                    <div className="flex items-center">
                      <h3 className="font-display text-sm font-bold uppercase">{cfg.label}</h3>
                      {manifests.find((m) => m.id === cfg.type)?.authType === 'qr-code' &&
                        typeAccounts.length === 0 && <ConnectorStatusDot type={cfg.type} />}
                    </div>
                    <p className="font-mono text-xs text-nb-muted flex items-center gap-2">
                      <span>{formatAccountCount(typeAccounts.length)}</span>
                      {status && (
                        <span className="inline-flex items-center gap-1" title={status.label}>
                          <span
                            className={cn(
                              'size-2 border border-nb-border',
                              status.pulse && 'animate-pulse',
                            )}
                            style={{ backgroundColor: status.color }}
                          />
                          <span className="uppercase">{status.label}</span>
                        </span>
                      )}
                    </p>
                  </div>
                </div>
                <span className="font-bold text-lg">{isExpanded ? '−' : '+'}</span>
              </button>
              {isExpanded && (
                <div
                  className="border-t-3 border-nb-border p-3 flex flex-col gap-2 bg-nb-surface-muted"
                  data-tour="sync-trigger"
                >
                  {typeAccounts.map((acc) => {
                    const manifest = manifests.find((m) => m.id === cfg.type);
                    return (
                      <ConnectorAccountRow
                        key={acc.id}
                        account={acc}
                        authType={manifest?.authType}
                        syncConfig={manifest?.sync}
                        onRemove={removeAccount}
                        onSyncNow={(id: string, memoryBankId?: string) => syncNow(id, memoryBankId)}
                        onEdit={(id) => setEditModal({ type: cfg.type, accountId: id })}
                      />
                    );
                  })}
                  {typeAccounts.length === 0 && (
                    <EmptyState
                      icon="+"
                      title="No Accounts Connected"
                      subtitle="Add an account to start syncing"
                    />
                  )}
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => setModalType(cfg.type)}
                    className="self-start"
                  >
                    + ADD ACCOUNT
                  </Button>
                </div>
              )}
            </Card>
          );
        })}
      </div>

      {modalType && (
        <ConnectorSetupModal
          open={!!modalType}
          onClose={() => setModalType(null)}
          connectorType={modalType}
          onConnect={() => {
            fetchAccounts();
            setModalType(null);
          }}
        />
      )}

      {editModal && (
        <ConnectorSetupModal
          open={!!editModal}
          onClose={() => setEditModal(null)}
          connectorType={editModal.type}
          editAccountId={editModal.accountId}
          onConnect={() => {
            fetchAccounts();
            setEditModal(null);
          }}
        />
      )}
    </PageContainer>
  );
}
