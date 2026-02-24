import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { ConnectorType, SyncSchedule } from '@botmem/shared';
import { connectorConfigs } from '../../mock/connectors';
import { ConnectorCard } from '../connectors/ConnectorCard';
import { ConnectorSetupModal } from '../connectors/ConnectorSetupModal';
import { SyncSchedulePicker } from '../connectors/SyncSchedulePicker';
import { ProgressBar } from '../ui/ProgressBar';
import { Button } from '../ui/Button';
import { useConnectors } from '../../hooks/useConnectors';
import { useAuth } from '../../hooks/useAuth';

export function OnboardingSteps() {
  const [step, setStep] = useState(0);
  const [modalType, setModalType] = useState<ConnectorType | null>(null);
  const [schedule, setSchedule] = useState<SyncSchedule>('hourly');
  const { accounts, manifests, addAccount, fetchAccounts, loading } = useConnectors();
  const { completeOnboarding } = useAuth();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  // Handle OAuth callback redirect
  useEffect(() => {
    if (searchParams.get('auth') === 'success') {
      fetchAccounts();
      setSearchParams({}, { replace: true });
    }
  }, []);

  // Prefer manifests from API over mock configs
  const displayConfigs = manifests.length > 0
    ? manifests.map((m) => ({ type: m.id as ConnectorType, label: m.name, color: m.color, description: m.description }))
    : connectorConfigs;

  const handleFinish = () => {
    completeOnboarding();
    navigate('/dashboard');
  };

  return (
    <div className="max-w-3xl mx-auto">
      <ProgressBar value={step + 1} max={2} segments={2} className="mb-8" />

      {step === 0 && (
        <div>
          <h2 className="font-display text-2xl font-bold uppercase mb-2 text-nb-text">Connect Your Sources</h2>
          <p className="font-mono text-sm text-nb-muted mb-6">
            Choose which services to import memories from. You can add more later.
          </p>

          {loading ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 mb-6">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-32 border-3 border-nb-border bg-nb-surface animate-pulse" />
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 mb-6">
              {displayConfigs.map((cfg) => {
                const connected = accounts.filter((a) => a.type === cfg.type);
                return (
                  <ConnectorCard
                    key={cfg.type}
                    config={cfg}
                    connected={connected.length > 0}
                    accountCount={connected.length}
                    onConnect={() => setModalType(cfg.type)}
                  />
                );
              })}
            </div>
          )}

          {accounts.length > 0 && (
            <Button size="lg" onClick={() => setStep(1)} className="w-full">
              CONTINUE
            </Button>
          )}

          {accounts.length === 0 && (
            <button
              onClick={() => setStep(1)}
              className="font-mono text-sm text-nb-muted hover:text-nb-text underline cursor-pointer block mx-auto mt-4"
            >
              SKIP FOR NOW
            </button>
          )}
        </div>
      )}

      {step === 1 && (
        <div>
          <h2 className="font-display text-2xl font-bold uppercase mb-2 text-nb-text">Sync Schedule</h2>
          <p className="font-mono text-sm text-nb-muted mb-6">
            How often should we check for new data?
          </p>

          <SyncSchedulePicker value={schedule} onChange={setSchedule} />

          <Button size="lg" onClick={handleFinish} className="w-full mt-8">
            FINISH SETUP
          </Button>
        </div>
      )}

      {modalType && (
        <ConnectorSetupModal
          open={!!modalType}
          onClose={() => setModalType(null)}
          connectorType={modalType}
          onConnect={(identifier) => addAccount(modalType, identifier)}
        />
      )}
    </div>
  );
}
