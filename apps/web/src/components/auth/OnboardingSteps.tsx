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
import { useAuthStore } from '../../store/authStore';

export function OnboardingSteps() {
  const recoveryKey = useAuthStore((s) => s.recoveryKey);
  const dismissRecoveryKey = useAuthStore((s) => s.dismissRecoveryKey);
  const [hasKeyStep] = useState(() => !!recoveryKey);
  const [step, setStep] = useState(hasKeyStep ? 0 : 1);
  const [modalType, setModalType] = useState<ConnectorType | null>(null);
  const [schedule, setSchedule] = useState<SyncSchedule>('hourly');
  const [copied, setCopied] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
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
  const displayConfigs =
    manifests.length > 0
      ? manifests.map((m) => ({
          type: m.id as ConnectorType,
          label: m.name,
          color: m.color,
          description: m.description,
        }))
      : connectorConfigs;

  const handleFinish = () => {
    completeOnboarding();
    navigate('/dashboard');
  };

  const handleCopyKey = async () => {
    if (!recoveryKey) return;
    await navigator.clipboard.writeText(recoveryKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleKeyStepDone = () => {
    dismissRecoveryKey();
    setStep(1);
  };

  const totalSteps = hasKeyStep ? 3 : 2;
  const progressStep = hasKeyStep ? step + 1 : step;

  return (
    <div className="max-w-3xl mx-auto">
      <ProgressBar value={progressStep} max={totalSteps} segments={totalSteps} className="mb-8" />

      {step === 0 && hasKeyStep && (
        <div className="text-center">
          <div className="inline-block mb-6">
            <div className="w-16 h-16 border-3 border-nb-border bg-nb-surface mx-auto flex items-center justify-center shadow-nb">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                className="w-8 h-8 text-nb-lime"
              >
                <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
              </svg>
            </div>
          </div>

          <h2 className="font-display text-2xl font-bold uppercase mb-2 text-nb-text">
            Your Recovery Key
          </h2>
          <p className="font-mono text-sm text-nb-muted mb-6 max-w-md mx-auto">
            This key encrypts all your data. Without it, your memories cannot be recovered. Save it
            somewhere safe — we can't retrieve it for you.
          </p>

          <div className="relative border-3 border-nb-border bg-nb-surface shadow-nb p-6 mb-6">
            <div className="absolute -top-3 left-4 bg-nb-red px-2 py-0.5">
              <span className="font-display text-[10px] font-bold uppercase tracking-wider text-white">
                Save This Key
              </span>
            </div>
            <code className="block font-mono text-lg text-nb-text break-all select-all leading-relaxed mt-1">
              {recoveryKey}
            </code>
            <button
              onClick={handleCopyKey}
              className="absolute top-3 right-3 px-3 py-1.5 border-2 border-nb-border bg-nb-bg font-mono text-xs font-bold uppercase tracking-wider text-nb-muted hover:text-nb-text hover:border-nb-lime hover:bg-nb-lime/10 cursor-pointer transition-colors"
            >
              {copied ? 'Copied!' : 'Copy'}
            </button>
          </div>

          <label className="flex items-center gap-3 cursor-pointer justify-center mb-6">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
              className="w-5 h-5 accent-[#C4F53A] cursor-pointer"
            />
            <span className="font-mono text-sm text-nb-muted">
              I have saved my recovery key in a safe place
            </span>
          </label>

          <Button size="lg" onClick={handleKeyStepDone} disabled={!confirmed} className="w-full">
            Continue
          </Button>
        </div>
      )}

      {step === 1 && (
        <div>
          <h2 className="font-display text-2xl font-bold uppercase mb-2 text-nb-text">
            Connect Your Sources
          </h2>
          <p className="font-mono text-sm text-nb-muted mb-6">
            Choose which services to import memories from. You can add more later.
          </p>

          {loading ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 mb-6">
              {[1, 2, 3].map((i) => (
                <div
                  key={i}
                  className="h-32 border-3 border-nb-border bg-nb-surface animate-pulse"
                />
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
            <Button size="lg" onClick={() => setStep(2)} className="w-full">
              CONTINUE
            </Button>
          )}

          {accounts.length === 0 && (
            <button
              onClick={() => setStep(2)}
              className="font-mono text-sm text-nb-muted hover:text-nb-text underline cursor-pointer block mx-auto mt-4"
            >
              SKIP FOR NOW
            </button>
          )}
        </div>
      )}

      {step === 2 && (
        <div>
          <h2 className="font-display text-2xl font-bold uppercase mb-2 text-nb-text">
            Sync Schedule
          </h2>
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
