import { useEffect, useReducer, useRef, useCallback, useState } from 'react';
import { cn } from '@/lib/utils';
import type { ConnectorType } from '@botmem/shared';
import { Modal } from '../ui/Modal';
import { Input } from '../ui/Input';
import { Button } from '../ui/Button';
import { api, createWsConnection, waitForAuth, subscribeToChannel } from '../../lib/api';
import { appleTunnelUrl } from '../../lib/urls';
import { useConnectorStore } from '../../store/connectorStore';
import { isFirebaseMode } from '../../store/authStore';

const FIREBASE_HIDDEN_FIELDS = new Set([
  'clientId',
  'clientSecret',
  'apiId',
  'apiHash',
  'tenantId',
  'redirectUri',
]);

const APPLE_BRIDGE_GITHUB_RELEASE_URL =
  (import.meta.env.VITE_APPLE_BRIDGE_GITHUB_RELEASE_URL as string | undefined) ||
  'https://github.com/botmem/botmem/releases/latest';
const AUTH_TIMEOUT_MS = 120_000;

interface ConnectorSetupModalProps {
  open: boolean;
  onClose: () => void;
  connectorType: ConnectorType;
  onConnect: (identifier: string) => void;
  editAccountId?: string;
  editIdentifier?: string;
}

const fallbackFields: Record<
  string,
  Array<{ name: string; label: string; placeholder: string }>
> = {
  gmail: [{ name: 'email', label: 'Gmail Address', placeholder: 'you@gmail.com' }],
  slack: [{ name: 'workspace', label: 'Workspace Name', placeholder: 'my-workspace' }],
  apple: [{ name: 'appleId', label: 'Apple ID', placeholder: 'you@icloud.com' }],
  imessage: [{ name: 'appleId', label: 'Apple ID', placeholder: 'you@icloud.com' }],
  photos: [{ name: 'host', label: 'Immich Server URL', placeholder: 'http://localhost:2283' }],
};

interface SchemaField {
  name: string;
  label: string;
  placeholder: string;
  type: string;
  readOnly?: boolean;
  required?: boolean;
  default?: string | number;
}

interface AuthMethod {
  id: string;
  label: string;
  fields: string[];
}

interface ModalState {
  values: Record<string, string>;
  fields: SchemaField[];
  authMethods: AuthMethod[];
  selectedMethod: string | null;
  loading: boolean;
  checkingCredentials: boolean;
  qrData: string | null;
  qrError: string | null;
  error: string | null;
}

type ModalAction =
  | { type: 'SET_VALUE'; name: string; value: string }
  | { type: 'RESET_VALUES' }
  | { type: 'SET_FIELDS'; fields: SchemaField[]; authMethods?: AuthMethod[] }
  | { type: 'SET_METHOD'; method: string }
  | { type: 'SET_LOADING'; loading: boolean }
  | { type: 'CREDENTIALS_CHECKED' }
  | { type: 'QR_RECEIVED'; qrData: string }
  | { type: 'QR_ERROR'; error: string }
  | { type: 'QR_RETRY' }
  | { type: 'SET_ERROR'; error: string }
  | { type: 'RESET' };

const initialState: ModalState = {
  values: {},
  fields: [],
  authMethods: [],
  selectedMethod: null,
  loading: false,
  checkingCredentials: true,
  qrData: null,
  qrError: null,
  error: null,
};

function reducer(state: ModalState, action: ModalAction): ModalState {
  switch (action.type) {
    case 'SET_VALUE':
      return { ...state, values: { ...state.values, [action.name]: action.value }, error: null };
    case 'RESET_VALUES':
      return { ...state, values: {} };
    case 'SET_FIELDS': {
      const authMethods = action.authMethods || [];
      const defaultValues: Record<string, string> = {};
      for (const field of action.fields) {
        if (field.default !== undefined) {
          defaultValues[field.name] = String(field.default);
        }
      }
      return {
        ...state,
        fields: action.fields,
        authMethods,
        selectedMethod: authMethods[0]?.id || null,
        values: defaultValues,
      };
    }
    case 'SET_METHOD':
      return { ...state, selectedMethod: action.method, values: {} };
    case 'SET_LOADING':
      return { ...state, loading: action.loading };
    case 'CREDENTIALS_CHECKED':
      return { ...state, checkingCredentials: false };
    case 'QR_RECEIVED':
      return { ...state, qrData: action.qrData, loading: false, qrError: null };
    case 'QR_ERROR':
      return { ...state, qrError: action.error, loading: false };
    case 'QR_RETRY':
      return { ...state, qrError: null, qrData: null, loading: true };
    case 'SET_ERROR':
      return { ...state, error: action.error, loading: false };
    case 'RESET':
      return initialState;
    default:
      return state;
  }
}

interface JsonSchemaProperty {
  title?: string;
  description?: string;
  type?: string;
  readOnly?: boolean;
  default?: string | number;
}

interface JsonSchema {
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  authMethods?: AuthMethod[];
}

function schemaToFields(schema: JsonSchema): SchemaField[] {
  if (!schema?.properties) return [];
  const requiredFields: string[] = schema.required || [];
  return Object.entries(schema.properties).map(([name, prop]) => ({
    name,
    label: prop.title || name,
    placeholder: prop.description || '',
    type: prop.type || 'string',
    readOnly: prop.readOnly,
    required: requiredFields.includes(name),
    default: prop.default,
  }));
}

function authErrorMessage(err: unknown, fallback: string) {
  const raw = (err instanceof Error ? err.message : String(err)) || '';
  const jsonMatch = raw.match(/API \d+: (.+)/s);
  if (!jsonMatch) return raw || fallback;
  try {
    return JSON.parse(jsonMatch[1]).message || fallback;
  } catch {
    return jsonMatch[1] || fallback;
  }
}

// --- Step indicator for multi-step flows ---

function StepIndicator({ current, total }: { current: number; total: number }) {
  return (
    <div className="flex items-center gap-2 mb-4">
      {Array.from({ length: total }, (_, i) => {
        const step = i + 1;
        const isActive = step === current;
        const isDone = step < current;
        return (
          <div key={step} className="flex items-center gap-2">
            {i > 0 && <div className={cn('h-0.5 w-6', isDone ? 'bg-nb-lime' : 'bg-nb-border')} />}
            <div
              className={cn(
                'size-7 flex items-center justify-center font-display text-xs font-bold border-3 transition-colors',
                isActive
                  ? 'border-nb-lime bg-nb-lime text-black'
                  : isDone
                    ? 'border-nb-lime bg-nb-lime/20 text-nb-text'
                    : 'border-nb-border bg-nb-surface text-nb-muted',
              )}
            >
              {isDone ? '\u2713' : step}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// --- Phone Code Auth View (Telegram-style multi-step) ---

type PhoneAuthStep = 'phone' | 'code' | '2fa';

function PhoneCodeAuthView({
  connectorType,
  onClose,
  wsRef,
  cleanupWs,
}: {
  connectorType: ConnectorType;
  onClose: () => void;
  wsRef: React.MutableRefObject<WebSocket | null>;
  cleanupWs: () => void;
}) {
  const fetchAccounts = useConnectorStore((s) => s.fetchAccounts);
  const manifests = useConnectorStore((s) => s.manifests);
  const manifest = manifests.find((m) => m.id === connectorType);
  const schema = manifest?.configSchema as JsonSchema | undefined;
  const fields = schema ? schemaToFields(schema) : [];

  const [step, setStep] = useState<PhoneAuthStep>('phone');
  const [phone, setPhone] = useState('');
  const [apiId, setApiId] = useState('');
  const [apiHash, setApiHash] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wsChannel, setWsChannel] = useState<string | null>(null);

  const codeInputRef = useRef<HTMLInputElement>(null);
  const passwordInputRef = useRef<HTMLInputElement>(null);

  // Focus code/password input when step changes
  useEffect(() => {
    if (step === 'code') codeInputRef.current?.focus();
    if (step === '2fa') passwordInputRef.current?.focus();
  }, [step]);

  useEffect(() => {
    if (step === 'phone' || error) return;
    // ponytail: fixed timeout; make it server-driven if auth sessions gain explicit expiry.
    const timer = setTimeout(() => {
      setError('Authentication timed out. Try again.');
      setLoading(false);
      cleanupWs();
    }, AUTH_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [cleanupWs, error, step]);

  const setupWsListener = useCallback(
    (channel: string) => {
      const ws = createWsConnection();
      wsRef.current = ws;

      ws.onopen = () => {
        waitForAuth(ws)
          .then(() => subscribeToChannel(ws, channel))
          .catch(() => ws.close());
      };

      ws.onmessage = (evt) => {
        try {
          const msg = JSON.parse(evt.data);
          if (msg.event === 'auth') return;

          if (msg.event === 'auth:status') {
            if (msg.data?.status === 'success') {
              cleanupWs();
              fetchAccounts();
              onClose();
            } else if (msg.data?.status === 'connecting') {
              setLoading(true);
              setError(null);
            }
          } else if (msg.event === 'auth:need_2fa') {
            setStep('2fa');
            setLoading(false);
            setError(null);
          } else if (msg.event === 'auth:error') {
            setError(msg.data?.error || 'Authentication failed');
            setLoading(false);
          }
        } catch {
          /* ignore */
        }
      };

      ws.onerror = () => {
        setError('WebSocket connection failed');
        setLoading(false);
      };
    },
    [wsRef, cleanupWs, fetchAccounts, onClose],
  );

  const handlePhoneSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const config: Record<string, string> = { phone };
      if (apiId) config.apiId = apiId;
      if (apiHash) config.apiHash = apiHash;

      const result = await api.initiateAuth(connectorType, config);

      if (result.type === 'phone-code' && result.wsChannel) {
        setWsChannel(result.wsChannel);
        setupWsListener(result.wsChannel);
        setStep('code');
        setLoading(false);
      } else {
        setError('Unexpected auth response');
        setLoading(false);
      }
    } catch (err: unknown) {
      setError(authErrorMessage(err, 'Failed to send code'));
      setLoading(false);
    }
  };

  const handleCodeSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!wsChannel || !wsRef.current) return;
    setLoading(true);
    setError(null);

    // Send code via WS — server handles verification and responds via WS events
    wsRef.current.send(JSON.stringify({ event: 'auth:code', data: { wsChannel, code } }));
  };

  const handle2faSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!wsChannel || !wsRef.current) return;
    setLoading(true);
    setError(null);

    wsRef.current.send(JSON.stringify({ event: 'auth:2fa', data: { wsChannel, password } }));
  };

  const stepNumber = step === 'phone' ? 1 : step === 'code' ? 2 : 3;
  const totalSteps = step === '2fa' ? 3 : 2;

  // Filter fields for Firebase mode
  const showApiFields = !isFirebaseMode && fields.some((f) => f.name === 'apiId');

  return (
    <Modal
      open
      onClose={() => {
        cleanupWs();
        onClose();
      }}
      title={`Connect ${connectorType.toUpperCase()}`}
    >
      <StepIndicator current={stepNumber} total={totalSteps} />

      {error && (
        <div className="border-3 border-nb-red bg-nb-red/10 p-3 font-mono text-sm text-nb-red mb-4">
          {error}
        </div>
      )}

      {/* Step 1: Phone Number */}
      {step === 'phone' && (
        <form onSubmit={handlePhoneSubmit} className="flex flex-col gap-4">
          <Input
            label="Phone Number"
            placeholder="+1234567890"
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            required
            autoFocus
          />

          {showApiFields && (
            <>
              <div className="border-t-3 border-nb-border pt-3">
                <p className="font-mono text-[11px] text-nb-muted uppercase mb-3">
                  Optional — get from my.telegram.org/apps
                </p>
              </div>
              <Input
                label="API ID"
                placeholder="From my.telegram.org/apps"
                value={apiId}
                onChange={(e) => setApiId(e.target.value)}
              />
              <Input
                label="API Hash"
                placeholder="From my.telegram.org/apps"
                value={apiHash}
                onChange={(e) => setApiHash(e.target.value)}
              />
            </>
          )}

          <Button type="submit" disabled={loading}>
            {loading ? 'SENDING CODE...' : 'SEND CODE'}
          </Button>
        </form>
      )}

      {/* Step 2: Verification Code */}
      {step === 'code' && (
        <form onSubmit={handleCodeSubmit} className="flex flex-col gap-4">
          <p className="font-mono text-xs text-nb-muted uppercase text-center">
            Enter the code sent to your Telegram app
          </p>

          <Input
            ref={codeInputRef}
            label="Verification Code"
            placeholder="12345"
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            required
            className="text-center text-2xl tracking-[0.5em] font-mono"
          />

          <div className="flex items-center gap-2 justify-center">
            <div className="size-2 bg-nb-lime rounded-full animate-pulse" />
            <p className="font-mono text-[11px] text-nb-muted uppercase">Waiting for code...</p>
          </div>

          <Button type="submit" disabled={loading || !code}>
            {loading ? 'VERIFYING...' : 'VERIFY'}
          </Button>

          <button
            type="button"
            onClick={() => {
              setStep('phone');
              setCode('');
              setError(null);
              cleanupWs();
            }}
            className="font-mono text-xs text-nb-muted uppercase cursor-pointer hover:text-nb-text transition-colors"
          >
            Back to phone number
          </button>
        </form>
      )}

      {/* Step 3: 2FA Password */}
      {step === '2fa' && (
        <form onSubmit={handle2faSubmit} className="flex flex-col gap-4">
          <p className="font-mono text-xs text-nb-muted uppercase text-center">
            Your account has two-factor authentication enabled
          </p>

          <Input
            ref={passwordInputRef}
            label="2FA Password"
            placeholder="Your cloud password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />

          <Button type="submit" disabled={loading || !password}>
            {loading ? 'AUTHENTICATING...' : 'SUBMIT'}
          </Button>
        </form>
      )}
    </Modal>
  );
}

// --- Bridge Auth View (Apple remote tunnel) ---
// Linear 3-step flow: Download -> Connect -> Status.

type BridgeStep = 'download' | 'connect' | 'status';

const BRIDGE_SOURCES = 'contacts,imessages';

function buildBridgeDeepLink(opts: { server: string; token: string; accountId: string }): string {
  const link = new URL('botmem-apple-bridge://connect');
  link.searchParams.set('server', opts.server);
  link.searchParams.set('token', opts.token);
  link.searchParams.set('accountId', opts.accountId);
  link.searchParams.set('sources', BRIDGE_SOURCES);
  return link.toString();
}

// Foreground (headless) bridge command — the terminal alternative to the Mac
// app. Running in the foreground reuses the terminal's Full Disk Access; the
// `service start` LaunchAgent path would lose FDA now that the signed app is
// the canonical supervisor. Values are single-quoted to stay shell-safe.
function buildBridgeCommand(opts: { server: string; token: string; accountId: string }): string {
  return `npx @botmem/apple-bridge@latest --token='${opts.token}' --server='${opts.server}' --account-id='${opts.accountId}'`;
}

function BridgeAuthView({
  connectorType,
  onClose,
  onConnect,
  editAccountId,
  editIdentifier,
}: {
  connectorType: ConnectorType;
  onClose: () => void;
  onConnect: (id: string) => void;
  editAccountId?: string;
  editIdentifier?: string;
}) {
  const fetchAccounts = useConnectorStore((s) => s.fetchAccounts);
  // Reconnect skips the download step — the app is already installed.
  const isReconnect = !!editAccountId;
  const [step, setStep] = useState<BridgeStep>(isReconnect ? 'connect' : 'download');
  const [myIdentifier, setMyIdentifier] = useState(editIdentifier || '');
  const [bridgeCommand, setBridgeCommand] = useState('');
  const [bridgeDeepLink, setBridgeDeepLink] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [accountId, setAccountId] = useState<string | null>(editAccountId || null);
  const [bridgeStatus, setBridgeStatus] = useState<{
    connected: boolean;
    sources: { contacts: boolean; imessages: boolean } | null;
  }>({ connected: false, sources: null });
  const [copied, setCopied] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (pollRef.current) clearTimeout(pollRef.current);
    };
  }, []);

  const startPolling = (acctId: string) => {
    if (pollRef.current) clearTimeout(pollRef.current);
    let delayMs = 2000;
    const poll = async () => {
      try {
        const data = await api.getBridgeStatus(acctId);
        setBridgeStatus({ connected: data.connected, sources: data.sources });
        if (data.connected) {
          if (pollRef.current) clearTimeout(pollRef.current);
          pollRef.current = null;
          return;
        }
      } catch {
        // Offline bridges are shown as waiting; the next poll backs off.
      }
      delayMs = Math.min(delayMs * 2, 15000);
      pollRef.current = setTimeout(poll, delayMs);
    };
    pollRef.current = setTimeout(poll, delayMs);
  };

  // Provision the account (token + accountId), build the deep link, move to status.
  const setupBridge = async () => {
    setLoading(true);
    setError(null);

    try {
      const result = await api.initiateAuth(connectorType, {
        myIdentifier,
        authMethod: 'bridge',
        tunnelMode: true,
        selectedSources: { contacts: true, imessages: true },
      });

      if (result.type === 'complete' && result.account) {
        const acct = result.account as Record<string, string>;
        const acctId = acct.id || editAccountId || '';
        const token = acct.bridgeToken || '';
        const server = appleTunnelUrl();
        const deepLink = buildBridgeDeepLink({ server, token, accountId: acctId });

        setAccountId(acctId);
        setBridgeDeepLink(deepLink);
        setBridgeCommand(buildBridgeCommand({ server, token, accountId: acctId }));
        setStep('status');

        // Hand off to the bridge app, then wait for it to phone home.
        try {
          window.location.href = deepLink;
        } catch {
          // Custom-scheme navigation can throw in non-browser/test envs; the
          // status step still surfaces a manual "Reopen the app" link.
        }
        startPolling(acctId);
      } else {
        setError('Unexpected response from server');
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to create bridge';
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  const handleConnectSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await setupBridge();
  };

  const handleStartSync = async () => {
    if (!accountId) return;
    setLoading(true);
    try {
      await api.triggerSync(accountId);
      fetchAccounts();
      onConnect(myIdentifier);
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to start sync');
    } finally {
      setLoading(false);
    }
  };

  const copyCommand = () => {
    navigator.clipboard.writeText(bridgeCommand);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const stepNumber = step === 'download' ? 1 : step === 'connect' ? 2 : 3;

  return (
    <Modal open onClose={onClose} title="Connect Apple">
      <StepIndicator current={stepNumber} total={3} />

      {error && (
        <div className="border-3 border-nb-red bg-nb-red/10 p-3 font-mono text-sm text-nb-red mb-4">
          {error}
        </div>
      )}

      {/* Step 1: Download */}
      {step === 'download' && (
        <div className="flex flex-col gap-4">
          <p className="font-mono text-xs text-nb-muted uppercase">
            Get the Mac app that reads your Apple data and streams it over an encrypted tunnel.
          </p>
          <a
            href={APPLE_BRIDGE_GITHUB_RELEASE_URL}
            target="_blank"
            rel="noreferrer"
            className="font-display font-bold uppercase tracking-wider border-3 border-nb-border shadow-nb px-5 py-2.5 text-sm bg-nb-lime text-black text-center transition-all duration-100 cursor-pointer hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-nb-sm active:translate-x-[4px] active:translate-y-[4px] active:shadow-none"
          >
            Download Botmem for Mac
          </a>
          <p className="font-mono text-xs text-nb-muted">
            Install it, then come back and click Connect.
          </p>
          <Button type="button" onClick={() => setStep('connect')}>
            NEXT
          </Button>
        </div>
      )}

      {/* Step 2: Connect */}
      {step === 'connect' && (
        <form onSubmit={handleConnectSubmit} className="flex flex-col gap-4">
          <p className="font-mono text-xs text-nb-muted uppercase">
            Enter your iMessage email or phone so we know which side of conversations is you.
          </p>
          <Input
            label="Your Email or Phone"
            placeholder="you@icloud.com or +1234567890"
            value={myIdentifier}
            onChange={(e) => setMyIdentifier(e.target.value)}
            required
            autoFocus
          />
          <Button type="submit" disabled={loading || !myIdentifier}>
            {loading ? 'CONNECTING...' : 'CONNECT'}
          </Button>

          <details
            className="border-3 border-nb-border bg-nb-surface/50"
            open={showAdvanced}
            onToggle={(e) => setShowAdvanced((e.target as HTMLDetailsElement).open)}
          >
            <summary className="cursor-pointer select-none px-3 py-2 font-display text-xs font-bold uppercase text-nb-muted">
              Advanced: run from terminal
            </summary>
            <p className="px-3 pb-3 font-mono text-[11px] text-nb-muted">
              Prefer the terminal? Click Connect to provision a token, then run the bridge in the
              foreground on the Mac instead of opening the app.
            </p>
          </details>
        </form>
      )}

      {/* Step 3: Status */}
      {step === 'status' && (
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-3 py-2" role="status" aria-live="polite">
            {bridgeStatus.connected ? (
              <>
                <div className="size-3 bg-nb-lime" aria-hidden="true" />
                <p className="font-mono text-sm text-nb-lime uppercase font-bold">
                  Connected · live search active
                </p>
              </>
            ) : (
              <>
                <div className="size-3 bg-nb-muted animate-pulse" aria-hidden="true" />
                <p className="font-mono text-xs text-nb-muted uppercase">Waiting for the app…</p>
              </>
            )}
          </div>

          {bridgeStatus.connected && bridgeStatus.sources && (
            <div className="flex flex-wrap gap-2">
              {bridgeStatus.sources.contacts && (
                <span className="border-3 border-nb-lime bg-nb-lime/10 px-2 py-1 font-mono text-[10px] uppercase text-nb-lime">
                  Contacts
                </span>
              )}
              {bridgeStatus.sources.imessages && (
                <span className="border-3 border-nb-lime bg-nb-lime/10 px-2 py-1 font-mono text-[10px] uppercase text-nb-lime">
                  Messages
                </span>
              )}
            </div>
          )}

          {!bridgeStatus.connected && (
            <p className="font-mono text-xs text-nb-muted">
              Open Botmem for Mac if it didn't launch automatically.{' '}
              {bridgeDeepLink && (
                <a href={bridgeDeepLink} className="text-nb-lime underline underline-offset-2">
                  Reopen the app
                </a>
              )}
            </p>
          )}

          {bridgeCommand && (
            <details
              className="border-3 border-nb-border bg-nb-surface/50"
              open={showAdvanced}
              onToggle={(e) => setShowAdvanced((e.target as HTMLDetailsElement).open)}
            >
              <summary className="cursor-pointer select-none px-3 py-2 font-display text-xs font-bold uppercase text-nb-muted">
                Advanced: run from terminal
              </summary>
              <div className="flex flex-col gap-2 p-3 pt-0">
                <pre className="bg-black border-3 border-nb-border p-4 font-mono text-sm text-nb-lime overflow-x-auto whitespace-pre-wrap break-all">
                  {bridgeCommand}
                </pre>
                <button
                  type="button"
                  onClick={copyCommand}
                  className="self-end px-2 py-1 bg-nb-surface border-2 border-nb-border font-mono text-[10px] text-nb-muted uppercase hover:text-nb-text hover:border-nb-lime transition-colors cursor-pointer"
                >
                  {copied ? 'COPIED' : 'COPY'}
                </button>
              </div>
            </details>
          )}

          {bridgeStatus.connected && (
            <Button onClick={handleStartSync} disabled={loading}>
              {loading ? 'STARTING SYNC...' : 'DONE'}
            </Button>
          )}
        </div>
      )}
    </Modal>
  );
}

// --- Sub-components ---

function QrAuthView({
  state,
  dispatch,
  connectorType,
  wsRef,
  cleanupWs,
  onClose,
}: {
  state: ModalState;
  dispatch: React.Dispatch<ModalAction>;
  connectorType: ConnectorType;
  wsRef: React.MutableRefObject<WebSocket | null>;
  cleanupWs: () => void;
  onClose: () => void;
}) {
  const fetchAccounts = useConnectorStore((s) => s.fetchAccounts);

  const initiateQr = useCallback(() => {
    dispatch({ type: 'QR_RETRY' });
    api
      .initiateAuth(connectorType, {})
      .then((result) => {
        if (result.type === 'qr-code' && result.qrData) {
          dispatch({ type: 'QR_RECEIVED', qrData: result.qrData });
          const ws = createWsConnection();
          wsRef.current = ws;
          ws.onopen = () => {
            waitForAuth(ws)
              .then(() => subscribeToChannel(ws, result.wsChannel || ''))
              .catch(() => ws.close());
          };
          ws.onmessage = (evt) => {
            try {
              const msg = JSON.parse(evt.data);
              if (msg.event === 'auth') return; // handled by waitForAuth
              if (msg.event === 'auth:status' && msg.data?.status === 'success') {
                cleanupWs();
                // Backend already created the account — just refresh the list
                fetchAccounts();
                onClose();
              } else if (msg.event === 'auth:error') {
                dispatch({ type: 'QR_ERROR', error: msg.data.error || 'Authentication failed' });
                cleanupWs();
              } else if (msg.event === 'qr:update') {
                dispatch({ type: 'QR_RECEIVED', qrData: msg.data.qrData });
              }
            } catch {
              /* ignore parse errors */
            }
          };
          ws.onerror = () => dispatch({ type: 'QR_ERROR', error: 'WebSocket connection failed' });
        }
      })
      .catch((err) =>
        dispatch({ type: 'QR_ERROR', error: err.message || 'Failed to generate QR code' }),
      );
  }, [connectorType, wsRef, cleanupWs, fetchAccounts, onClose, dispatch]);

  useEffect(() => {
    if (!state.qrData || state.qrError) return;
    // ponytail: fixed timeout; replace with backend expiry when QR auth exposes one.
    const timer = setTimeout(() => {
      dispatch({
        type: 'QR_ERROR',
        error: 'QR login timed out. Generate a new code and try again.',
      });
      cleanupWs();
    }, AUTH_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [cleanupWs, dispatch, state.qrData, state.qrError]);

  return (
    <Modal
      open
      onClose={() => {
        cleanupWs();
        onClose();
      }}
      title={`Connect ${connectorType.toUpperCase()}`}
    >
      <div className="flex flex-col items-center gap-4 py-4">
        {state.loading && !state.qrData && !state.qrError && (
          <p className="font-mono text-sm text-nb-muted uppercase animate-pulse">
            Generating QR code...
          </p>
        )}

        {state.qrData && (
          <>
            <p className="font-mono text-xs text-nb-muted uppercase text-center">
              Scan this QR code with WhatsApp on your phone
            </p>
            <div className="bg-white p-3 rounded">
              <img src={state.qrData} alt="WhatsApp QR Code" className="size-64" />
            </div>
            <p className="font-mono text-[11px] text-nb-muted text-center">
              Open WhatsApp → Settings → Linked Devices → Link a Device
            </p>
            <div className="flex items-center gap-2 mt-2">
              <div className="size-2 bg-nb-lime rounded-full animate-pulse" />
              <p className="font-mono text-xs text-nb-muted uppercase">Waiting for scan...</p>
            </div>
          </>
        )}

        {state.qrError && (
          <div className="text-center">
            <p className="font-mono text-sm text-nb-red mb-3">{state.qrError}</p>
            <Button onClick={initiateQr}>RETRY</Button>
          </div>
        )}
      </div>
    </Modal>
  );
}

function FormView({
  state,
  dispatch,
  connectorType,
  onConnect,
  onClose,
  editAccountId,
  authType,
}: {
  state: ModalState;
  dispatch: React.Dispatch<ModalAction>;
  connectorType: ConnectorType;
  onConnect: (id: string) => void;
  onClose: () => void;
  editAccountId?: string;
  authType?: string;
}) {
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    dispatch({ type: 'SET_LOADING', loading: true });

    try {
      if (editAccountId) {
        const account = await api.reauthAccount(connectorType, editAccountId, state.values);
        onConnect((account as { identifier?: string }).identifier || connectorType);
        dispatch({ type: 'RESET_VALUES' });
        onClose();
        return;
      }

      const result = await api.initiateAuth(connectorType, {
        ...state.values,
        returnTo: window.location.pathname,
      });

      if (result.type === 'redirect' && result.url) {
        window.open(result.url, '_blank', 'noopener,noreferrer');
        return;
      }

      if (result.type === 'complete') {
        if (!result.account) {
          dispatch({ type: 'SET_ERROR', error: 'Connection did not return a connected account' });
          return;
        }
        onConnect(result.account.identifier || connectorType);
        dispatch({ type: 'RESET_VALUES' });
        onClose();
        return;
      }

      dispatch({ type: 'SET_ERROR', error: 'Connection did not complete' });
    } catch (err: unknown) {
      dispatch({ type: 'SET_ERROR', error: authErrorMessage(err, 'Connection failed') });
    } finally {
      dispatch({ type: 'SET_LOADING', loading: false });
    }
  };

  const activeMethod = state.authMethods.find((m) => m.id === state.selectedMethod);
  const visibleFields = (
    activeMethod ? state.fields.filter((f) => activeMethod.fields.includes(f.name)) : state.fields
  ).filter((f) => !(isFirebaseMode && FIREBASE_HIDDEN_FIELDS.has(f.name)));
  const showOAuthPreflight = authType === 'oauth2' && !editAccountId && visibleFields.length === 0;
  // ponytail: generic scope preview; render exact provider scopes when manifests expose them.
  const oauthProvider = connectorType === 'gmail' ? 'Google' : 'the authorization provider';

  return (
    <Modal open onClose={onClose} title={`Connect ${connectorType.toUpperCase()}`}>
      {state.authMethods.length > 1 && (
        <div className="flex gap-0 mb-4 border-3 border-nb-border">
          {state.authMethods.map((method) => (
            <button
              key={method.id}
              type="button"
              onClick={() => dispatch({ type: 'SET_METHOD', method: method.id })}
              className={cn(
                'flex-1 py-3 px-3 font-display text-sm font-bold uppercase transition-colors cursor-pointer border-r-3 border-nb-border last:border-r-0',
                state.selectedMethod === method.id
                  ? 'bg-nb-lime text-black'
                  : 'bg-nb-surface text-nb-muted hover:text-nb-text hover:bg-nb-border/30',
              )}
            >
              {method.label}
            </button>
          ))}
        </div>
      )}

      {state.error && (
        <div className="border-3 border-nb-red bg-nb-red/10 p-3 font-mono text-sm text-nb-red">
          {state.error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        {showOAuthPreflight && (
          <div className="border-3 border-nb-border bg-nb-surface/50 p-3">
            <p className="font-display text-xs font-bold uppercase text-nb-muted mb-2">
              Authorization Preview
            </p>
            <p className="font-mono text-xs text-nb-muted uppercase">
              You will continue to {oauthProvider} to review and approve this connector's requested
              scopes. You can cancel there before granting access.
            </p>
          </div>
        )}
        {visibleFields.map((field) =>
          field.readOnly ? (
            <p key={field.name} className="font-mono text-xs text-nb-muted">
              {field.placeholder}
            </p>
          ) : (
            <Input
              key={field.name}
              label={field.label}
              name={field.name}
              placeholder={field.placeholder}
              type={field.type === 'string' ? 'text' : field.type}
              value={state.values[field.name] || ''}
              onChange={(e) =>
                dispatch({ type: 'SET_VALUE', name: field.name, value: e.target.value })
              }
              required={field.required}
            />
          ),
        )}
        <Button type="submit" disabled={state.loading}>
          {state.loading
            ? editAccountId
              ? 'SAVING...'
              : 'CONNECTING...'
            : editAccountId
              ? 'SAVE CHANGES'
              : showOAuthPreflight
                ? connectorType === 'gmail'
                  ? 'CONTINUE TO GOOGLE'
                  : 'CONTINUE TO AUTHORIZATION'
                : 'CONNECT'}
        </Button>
      </form>
    </Modal>
  );
}

// --- Main component ---

export function ConnectorSetupModal({
  open,
  onClose,
  connectorType,
  onConnect,
  editAccountId,
  editIdentifier,
}: ConnectorSetupModalProps) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const wsRef = useRef<WebSocket | null>(null);
  const manifests = useConnectorStore((s) => s.manifests);

  const authType = manifests.find((m) => m.id === connectorType)?.authType;
  const isQrAuth = authType === 'qr-code';
  const isPhoneCodeAuth = authType === 'phone-code';
  const isBridgeAuth = connectorType === 'apple' || connectorType === 'imessage';

  const cleanupWs = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
  }, []);

  useEffect(() => cleanupWs, [cleanupWs]);

  const fetchAccountsForQr = useConnectorStore((s) => s.fetchAccounts);

  // QR code auth: auto-initiate
  useEffect(() => {
    if (!open || !isQrAuth) return;
    dispatch({ type: 'QR_RETRY' });

    api
      .initiateAuth(connectorType, {})
      .then((result) => {
        if (result.type === 'qr-code' && result.qrData) {
          dispatch({ type: 'QR_RECEIVED', qrData: result.qrData });
          const ws = createWsConnection();
          wsRef.current = ws;
          ws.onopen = () => {
            waitForAuth(ws)
              .then(() => subscribeToChannel(ws, result.wsChannel || ''))
              .catch(() => ws.close());
          };
          ws.onmessage = (evt) => {
            try {
              const msg = JSON.parse(evt.data);
              if (msg.event === 'auth') return; // handled by waitForAuth
              if (msg.event === 'auth:status' && msg.data?.status === 'success') {
                cleanupWs();
                // Backend already created the account — just refresh the list
                fetchAccountsForQr();
                onClose();
              } else if (msg.event === 'auth:error') {
                dispatch({ type: 'QR_ERROR', error: msg.data.error || 'Authentication failed' });
                cleanupWs();
              } else if (msg.event === 'qr:update') {
                dispatch({ type: 'QR_RECEIVED', qrData: msg.data.qrData });
              }
            } catch {
              /* ignore */
            }
          };
          ws.onerror = () => dispatch({ type: 'QR_ERROR', error: 'WebSocket connection failed' });
        }
      })
      .catch((err) =>
        dispatch({ type: 'QR_ERROR', error: err.message || 'Failed to generate QR code' }),
      );

    return cleanupWs;
  }, [open, isQrAuth, connectorType, cleanupWs, fetchAccountsForQr, onClose]);

  // Check saved credentials (OAuth only)
  useEffect(() => {
    if (isQrAuth || isPhoneCodeAuth) {
      dispatch({ type: 'CREDENTIALS_CHECKED' });
      return;
    }

    const manifest = manifests.find((m) => m.id === connectorType);
    if (manifest?.authType === 'oauth2') {
      api
        .hasCredentials(connectorType)
        .then(() => dispatch({ type: 'CREDENTIALS_CHECKED' }))
        .catch(() => dispatch({ type: 'CREDENTIALS_CHECKED' }));
    } else {
      dispatch({ type: 'CREDENTIALS_CHECKED' });
    }
  }, [connectorType, manifests, isQrAuth, isPhoneCodeAuth]);

  // Load form schema
  useEffect(() => {
    if (isQrAuth || isPhoneCodeAuth) return;

    const manifest = manifests.find((m) => m.id === connectorType);
    if (manifest?.configSchema) {
      const schema = manifest.configSchema as JsonSchema;
      dispatch({
        type: 'SET_FIELDS',
        fields: schemaToFields(schema),
        authMethods: schema.authMethods,
      });
    } else {
      api
        .getConnectorSchema(connectorType)
        .then(({ schema }) => {
          const typedSchema = schema as JsonSchema;
          dispatch({
            type: 'SET_FIELDS',
            fields: schemaToFields(typedSchema),
            authMethods: typedSchema.authMethods,
          });
        })
        .catch(() => {
          const fb = fallbackFields[connectorType] || [];
          dispatch({
            type: 'SET_FIELDS',
            fields: fb.map((f) => ({ ...f, type: 'string', required: true })),
          });
        });
    }
  }, [connectorType, manifests, isQrAuth, isPhoneCodeAuth]);

  if (!open) return null;

  if (isBridgeAuth) {
    return (
      <BridgeAuthView
        connectorType={connectorType}
        onClose={onClose}
        onConnect={onConnect}
        editAccountId={editAccountId}
        editIdentifier={editIdentifier}
      />
    );
  }

  if (isPhoneCodeAuth) {
    return (
      <PhoneCodeAuthView
        connectorType={connectorType}
        onClose={onClose}
        wsRef={wsRef}
        cleanupWs={cleanupWs}
      />
    );
  }

  if (isQrAuth) {
    return (
      <QrAuthView
        state={state}
        dispatch={dispatch}
        connectorType={connectorType}
        wsRef={wsRef}
        cleanupWs={cleanupWs}
        onClose={onClose}
      />
    );
  }

  if (state.checkingCredentials || (state.loading && !state.fields.length)) {
    return (
      <Modal
        open
        onClose={onClose}
        title={
          editAccountId
            ? `Edit ${connectorType.toUpperCase()}`
            : `Connect ${connectorType.toUpperCase()}`
        }
      >
        <div className="flex flex-col items-center gap-3 py-6">
          <p className="font-mono text-sm text-nb-muted uppercase">
            {state.loading ? 'Redirecting to authorization...' : 'Checking saved credentials...'}
          </p>
        </div>
      </Modal>
    );
  }

  return (
    <FormView
      state={state}
      dispatch={dispatch}
      connectorType={connectorType}
      onConnect={onConnect}
      onClose={onClose}
      editAccountId={editAccountId}
      authType={authType}
    />
  );
}
