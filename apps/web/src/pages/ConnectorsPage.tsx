import { useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { ConnectorType } from '@botmem/shared';
import { cn, CONNECTOR_COLORS } from '@botmem/shared';
import { PageContainer } from '../components/layout/PageContainer';
import { Card } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { ConnectorAccountRow } from '../components/connectors/ConnectorAccountRow';
import { ConnectorSetupModal } from '../components/connectors/ConnectorSetupModal';
import { connectorConfigs } from '../mock/connectors';
import { useConnectors } from '../hooks/useConnectors';
import { api, createWsConnection, subscribeToChannel } from '../lib/api';
import { EmptyState } from '../components/ui/EmptyState';

const connectorIcons: Record<string, string> = {
  gmail: '✉',
  whatsapp: '💬',
  slack: '#',
  imessage: '◯',
  photos: '📷',
  locations: '📍',
};

function ConnectorStatusDot({ type }: { type: string }) {
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const poll = () => {
      api.getConnectorStatus(type).then((s) => {
        if (!active) return;
        setStatus(s.status);
        if (s.status !== 'qr_ready') setTimeout(poll, 5000);
      }).catch(() => {});
    };
    poll();
    return () => { active = false; };
  }, [type]);

  if (!status) return null;

  const color = status === 'qr_ready' ? 'bg-green-400' : status === 'warming' ? 'bg-yellow-400 animate-pulse' : 'bg-red-400';
  const label = status === 'qr_ready' ? 'Ready' : status === 'warming' ? 'Starting...' : 'Offline';

  return (
    <span className="inline-flex items-center gap-1 ml-2">
      <span className={cn('w-2 h-2 rounded-full', color)} />
      <span className="font-mono text-[10px] text-nb-muted uppercase">{label}</span>
    </span>
  );
}

export function ConnectorsPage() {
  const { accounts, manifests, addAccount, removeAccount, syncNow, fetchAccounts } = useConnectors();
  const [searchParams, setSearchParams] = useSearchParams();

  // Handle OAuth callback redirect
  useEffect(() => {
    if (searchParams.get('auth') === 'success') {
      fetchAccounts();
      setSearchParams({}, { replace: true });
    }
  }, []);

  // Subscribe to connector warning notifications (e.g. WhatsApp decrypt failures)
  useEffect(() => {
    const ws = createWsConnection();
    ws.onopen = () => subscribeToChannel(ws, 'notifications');
    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data);
        if (msg.event === 'connector:warning') {
          // Refresh accounts to pick up lastError changes
          fetchAccounts();
        }
      } catch { /* ignore parse errors */ }
    };
    return () => ws.close();
  }, [fetchAccounts]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [modalType, setModalType] = useState<ConnectorType | null>(null);

  // Use manifests from API if available, fall back to mock configs
  const displayConfigs = manifests.length > 0
    ? manifests.map((m) => ({ type: m.id as ConnectorType, label: m.name, color: m.color, description: m.description }))
    : connectorConfigs;

  const toggle = (type: string) => {
    const next = new Set(expanded);
    if (next.has(type)) next.delete(type);
    else next.add(type);
    setExpanded(next);
  };

  return (
    <PageContainer>
      <div className="flex items-center justify-between mb-6">
        <h2 className="font-display text-xl font-bold uppercase text-nb-text">All Connectors</h2>
        <Button onClick={() => setModalType(displayConfigs[0]?.type || 'gmail')}>+ ADD CONNECTOR</Button>
      </div>

      <div className="flex flex-col gap-3">
        {displayConfigs.map((cfg) => {
          const typeAccounts = accounts.filter((a) => a.type === cfg.type);
          const isExpanded = expanded.has(cfg.type);
          return (
            <Card key={cfg.type} className="p-0 overflow-hidden">
              <button
                onClick={() => toggle(cfg.type)}
                className={cn(
                  'w-full flex items-center justify-between p-4 cursor-pointer hover:bg-nb-surface-hover transition-colors text-nb-text'
                )}
              >
                <div className="flex items-center gap-3">
                  <div
                    className="w-10 h-10 border-3 border-nb-border flex items-center justify-center text-lg font-bold"
                    style={{ backgroundColor: cfg.color || CONNECTOR_COLORS[cfg.type] }}
                  >
                    {connectorIcons[cfg.type] || '⚡'}
                  </div>
                  <div className="text-left">
                    <div className="flex items-center">
                      <h3 className="font-display text-sm font-bold uppercase">{cfg.label}</h3>
                      {manifests.find((m) => m.id === cfg.type)?.authType === 'qr-code' && (
                        <ConnectorStatusDot type={cfg.type} />
                      )}
                    </div>
                    <p className="font-mono text-xs text-nb-muted">{typeAccounts.length} accounts</p>
                  </div>
                </div>
                <span className="font-bold text-lg">{isExpanded ? '−' : '+'}</span>
              </button>
              {isExpanded && (
                <div className="border-t-3 border-nb-border p-3 flex flex-col gap-2 bg-nb-surface-muted">
                  {typeAccounts.map((acc) => (
                    <ConnectorAccountRow
                      key={acc.id}
                      account={acc}
                      onRemove={removeAccount}
                      onSyncNow={syncNow}
                    />
                  ))}
                  {typeAccounts.length === 0 && (
                    <EmptyState
                      icon="⚡"
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
          onConnect={(identifier) => addAccount(modalType, identifier)}
        />
      )}
    </PageContainer>
  );
}
