import { useReducer, useEffect } from 'react';
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
import { useTourStore } from '../../store/tourStore';
import { api } from '../../lib/api';
import { trackEvent } from '../../lib/posthog';

interface OnboardingState {
  step: number;
  modalType: ConnectorType | null;
  schedule: SyncSchedule;
  copied: boolean;
  confirmed: boolean;
  demoLoading: boolean;
  demoError: string | null;
}

type OnboardingAction =
  | { type: 'SET_STEP'; step: number }
  | { type: 'SET_MODAL'; modalType: ConnectorType | null }
  | { type: 'SET_SCHEDULE'; schedule: SyncSchedule }
  | { type: 'SET_COPIED'; copied: boolean }
  | { type: 'SET_CONFIRMED'; confirmed: boolean }
  | { type: 'DEMO_START' }
  | { type: 'DEMO_ERROR'; error: string }
  | { type: 'DEMO_DONE' };

function onboardingReducer(state: OnboardingState, action: OnboardingAction): OnboardingState {
  switch (action.type) {
    case 'SET_STEP':
      return { ...state, step: action.step };
    case 'SET_MODAL':
      return { ...state, modalType: action.modalType };
    case 'SET_SCHEDULE':
      return { ...state, schedule: action.schedule };
    case 'SET_COPIED':
      return { ...state, copied: action.copied };
    case 'SET_CONFIRMED':
      return { ...state, confirmed: action.confirmed };
    case 'DEMO_START':
      return { ...state, demoLoading: true, demoError: null };
    case 'DEMO_ERROR':
      return { ...state, demoLoading: false, demoError: action.error };
    case 'DEMO_DONE':
      return { ...state, demoLoading: false };
  }
}

export function OnboardingSteps() {
  const recoveryKey = useAuthStore((s) => s.recoveryKey);
  const dismissRecoveryKey = useAuthStore((s) => s.dismissRecoveryKey);
  const hasKeyStep = !!recoveryKey;
  const [state, dispatch] = useReducer(onboardingReducer, {
    step: hasKeyStep ? 0 : 1,
    modalType: null,
    schedule: 'hourly',
    copied: false,
    confirmed: false,
    demoLoading: false,
    demoError: null,
  });
  const { step, modalType, schedule, copied, confirmed, demoLoading, demoError } = state;
  const { accounts, manifests, addAccount, fetchAccounts, loading } = useConnectors();
  const { completeOnboarding } = useAuth();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  // Handle OAuth callback redirect — return user to the connect-sources step
  useEffect(() => {
    if (searchParams.get('auth') === 'success') {
      fetchAccounts();
      dispatch({ type: 'SET_STEP', step: 2 });
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
    dispatch({ type: 'SET_COPIED', copied: true });
    setTimeout(() => dispatch({ type: 'SET_COPIED', copied: false }), 2000);
  };

  const handleKeyStepDone = () => {
    dismissRecoveryKey();
    dispatch({ type: 'SET_STEP', step: 1 });
  };

  const handleExploreDemo = async () => {
    trackEvent('onboarding_path_chosen', { path: 'demo' });
    dispatch({ type: 'DEMO_START' });
    try {
      const result = await api.seedDemoData();
      if (!result.ok) {
        dispatch({ type: 'DEMO_ERROR', error: result.error || 'Failed to seed demo data' });
        return;
      }
      dispatch({ type: 'DEMO_DONE' });
      completeOnboarding();
      navigate('/me');
      // Small delay to let navigation complete before starting tour
      setTimeout(() => {
        useTourStore.getState().startTour(true);
      }, 500);
    } catch (err) {
      dispatch({
        type: 'DEMO_ERROR',
        error: err instanceof Error ? err.message : 'Failed to seed demo data',
      });
    }
  };

  const handleConnectNow = () => {
    trackEvent('onboarding_path_chosen', { path: 'connect' });
    dispatch({ type: 'SET_STEP', step: 2 });
  };

  const handleSkipOnboarding = () => {
    trackEvent('onboarding_skipped');
    completeOnboarding();
    navigate('/dashboard');
  };

  // Step numbering: 0 = recovery key (conditional), 1 = choose path, 2 = connect sources, 3 = sync schedule
  const totalSteps = hasKeyStep ? 4 : 3;
  const progressStep = hasKeyStep ? step + 1 : step;

  return (
    <div className="max-w-3xl mx-auto">
      <ProgressBar value={progressStep} max={totalSteps} segments={totalSteps} className="mb-8" />

      {step === 0 && hasKeyStep && (
        <div className="text-center">
          <div className="inline-block mb-6">
            <div className="size-16 border-3 border-nb-border bg-nb-surface mx-auto flex items-center justify-center shadow-nb">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                className="size-8 text-nb-lime"
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
              <span className="font-display text-[11px] font-bold uppercase tracking-wider text-white">
                Save This Key
              </span>
            </div>
            <code
              data-ph-mask
              className="block font-mono text-lg text-nb-text break-all select-all leading-relaxed mt-1"
            >
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
              onChange={(e) => dispatch({ type: 'SET_CONFIRMED', confirmed: e.target.checked })}
              className="size-5 accent-[#C4F53A] cursor-pointer"
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
          <h2 className="font-display text-2xl font-bold uppercase mb-2 text-nb-text text-center">
            Choose Your Path
          </h2>
          <p className="font-mono text-sm text-nb-muted mb-8 text-center">
            Jump right in with demo data, or connect your real accounts.
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 mb-6">
            {/* Card A: Explore Demo */}
            <button
              onClick={handleExploreDemo}
              disabled={demoLoading}
              className="group border-3 border-nb-border bg-nb-surface p-6 shadow-nb hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-none transition-all cursor-pointer text-left disabled:opacity-60 disabled:cursor-wait"
            >
              <div className="size-12 border-3 border-nb-border bg-nb-bg flex items-center justify-center mb-4 group-hover:border-nb-lime transition-colors">
                <svg
                  width="24"
                  height="24"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="text-nb-lime"
                >
                  <path d="M9 3H5a2 2 0 0 0-2 2v4m6-6h10a2 2 0 0 1 2 2v4M9 3v18m0 0h10a2 2 0 0 0 2-2V9M9 21H5a2 2 0 0 1-2-2V9m0 0h18" />
                </svg>
              </div>
              <h3 className="font-display text-lg font-bold uppercase text-nb-text mb-1">
                {demoLoading ? 'Loading...' : 'Explore Demo'}
              </h3>
              <p className="font-mono text-xs text-nb-muted">
                500 sample memories, 100 contacts — see the full experience with a guided tour
              </p>
            </button>

            {/* Card B: Connect Now */}
            <button
              onClick={handleConnectNow}
              disabled={demoLoading}
              className="group border-3 border-nb-border bg-nb-surface p-6 shadow-nb hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-none transition-all cursor-pointer text-left disabled:opacity-60"
            >
              <div className="size-12 border-3 border-nb-border bg-nb-bg flex items-center justify-center mb-4 group-hover:border-nb-lime transition-colors">
                <svg
                  width="24"
                  height="24"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="text-nb-lime"
                >
                  <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                  <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                </svg>
              </div>
              <h3 className="font-display text-lg font-bold uppercase text-nb-text mb-1">
                Connect Now
              </h3>
              <p className="font-mono text-xs text-nb-muted">
                Gmail, Slack, WhatsApp, iMessage, Photos & more — import your real data
              </p>
            </button>
          </div>

          {demoError && (
            <p className="font-mono text-sm text-nb-red text-center mb-4">{demoError}</p>
          )}

          <button
            onClick={handleSkipOnboarding}
            className="font-mono text-sm text-nb-muted hover:text-nb-text underline cursor-pointer block mx-auto mt-4"
          >
            Skip onboarding entirely
          </button>
        </div>
      )}

      {step === 2 && (
        <div>
          <h2 className="font-display text-2xl font-bold uppercase mb-2 text-nb-text">
            Connect Your Sources
          </h2>
          <p className="font-mono text-sm text-nb-muted mb-6">
            Choose which services to import memories from. You can add more later.
          </p>

          {loading ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 mb-6">
              {['skeleton-1', 'skeleton-2', 'skeleton-3'].map((id) => (
                <div
                  key={id}
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
                    onConnect={() => dispatch({ type: 'SET_MODAL', modalType: cfg.type })}
                  />
                );
              })}
            </div>
          )}

          {accounts.length > 0 && (
            <Button
              size="lg"
              onClick={() => dispatch({ type: 'SET_STEP', step: 3 })}
              className="w-full"
            >
              CONTINUE
            </Button>
          )}

          {accounts.length === 0 && (
            <button
              onClick={() => dispatch({ type: 'SET_STEP', step: 3 })}
              className="font-mono text-sm text-nb-muted hover:text-nb-text underline cursor-pointer block mx-auto mt-4"
            >
              SKIP FOR NOW
            </button>
          )}
        </div>
      )}

      {step === 3 && (
        <div>
          <h2 className="font-display text-2xl font-bold uppercase mb-2 text-nb-text">
            Sync Schedule
          </h2>
          <p className="font-mono text-sm text-nb-muted mb-6">
            How often should we check for new data?
          </p>

          <SyncSchedulePicker
            value={schedule}
            onChange={(s) => dispatch({ type: 'SET_SCHEDULE', schedule: s })}
          />

          <Button size="lg" onClick={handleFinish} className="w-full mt-8">
            FINISH SETUP
          </Button>
        </div>
      )}

      {modalType && (
        <ConnectorSetupModal
          open={!!modalType}
          onClose={() => dispatch({ type: 'SET_MODAL', modalType: null })}
          connectorType={modalType}
          onConnect={(identifier) => addAccount(modalType, identifier)}
        />
      )}
    </div>
  );
}
