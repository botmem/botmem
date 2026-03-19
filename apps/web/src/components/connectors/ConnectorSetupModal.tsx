import { useEffect, useReducer, useRef, useCallback, useState } from 'react';
import { cn } from '@/lib/utils';
import type { ConnectorType } from '@botmem/shared';
import { Modal } from '../ui/Modal';
import { Input } from '../ui/Input';
import { Button } from '../ui/Button';
import { api, createWsConnection, waitForAuth, subscribeToChannel } from '../../lib/api';
import { useConnectorStore } from '../../store/connectorStore';
import { isFirebaseMode } from '../../store/authStore';

const FIREBASE_HIDDEN_FIELDS = new Set(['clientId', 'clientSecret', 'apiId', 'apiHash']);

interface ConnectorSetupModalProps {
  open: boolean;
  onClose: () => void;
  connectorType: ConnectorType;
  onConnect: (identifier: string) => void;
  editAccountId?: string;
}

const fallbackFields: Record<
  string,
  Array<{ name: string; label: string; placeholder: string }>
> = {
  gmail: [{ name: 'email', label: 'Gmail Address', placeholder: 'you@gmail.com' }],
  slack: [{ name: 'workspace', label: 'Workspace Name', placeholder: 'my-workspace' }],
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
      let msg = 'Failed to send code';
      const raw = (err instanceof Error ? err.message : String(err)) || '';
      const jsonMatch = raw.match(/API \d+: (.+)/s);
      if (jsonMatch) {
        try {
          msg = JSON.parse(jsonMatch[1]).message || msg;
        } catch {
          msg = jsonMatch[1];
        }
      }
      setError(msg);
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
}: {
  state: ModalState;
  dispatch: React.Dispatch<ModalAction>;
  connectorType: ConnectorType;
  onConnect: (id: string) => void;
  onClose: () => void;
  editAccountId?: string;
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
        window.location.href = result.url;
        return;
      }

      if (result.type === 'complete') {
        onConnect(result.account?.identifier || connectorType);
        dispatch({ type: 'RESET_VALUES' });
        onClose();
        return;
      }

      onClose();
    } catch (err: unknown) {
      let msg = 'Connection failed — check your configuration';
      const raw = (err instanceof Error ? err.message : String(err)) || '';
      // Parse NestJS error body from "API 400: {json}"
      const jsonMatch = raw.match(/API \d+: (.+)/s);
      if (jsonMatch) {
        try {
          msg = JSON.parse(jsonMatch[1]).message || msg;
        } catch {
          msg = jsonMatch[1];
        }
      }
      dispatch({ type: 'SET_ERROR', error: msg });
    } finally {
      dispatch({ type: 'SET_LOADING', loading: false });
    }
  };

  const activeMethod = state.authMethods.find((m) => m.id === state.selectedMethod);
  const visibleFields = (
    activeMethod ? state.fields.filter((f) => activeMethod.fields.includes(f.name)) : state.fields
  ).filter((f) => !(isFirebaseMode && FIREBASE_HIDDEN_FIELDS.has(f.name)));

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
        {visibleFields.map((field) =>
          field.readOnly ? (
            <p key={field.name} className="font-mono text-xs text-nb-muted">
              {field.placeholder}
            </p>
          ) : (
            <Input
              key={field.name}
              label={field.label}
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
}: ConnectorSetupModalProps) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const wsRef = useRef<WebSocket | null>(null);
  const manifests = useConnectorStore((s) => s.manifests);

  const authType = manifests.find((m) => m.id === connectorType)?.authType;
  const isQrAuth = authType === 'qr-code';
  const isPhoneCodeAuth = authType === 'phone-code';

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
        .then(({ hasSavedCredentials }) => {
          if (hasSavedCredentials) {
            dispatch({ type: 'SET_LOADING', loading: true });
            api
              .initiateAuth(connectorType, { returnTo: window.location.pathname })
              .then((result) => {
                if (result.type === 'redirect' && result.url) window.location.href = result.url;
              })
              .catch(() => {
                dispatch({ type: 'CREDENTIALS_CHECKED' });
                dispatch({ type: 'SET_LOADING', loading: false });
              });
          } else {
            dispatch({ type: 'CREDENTIALS_CHECKED' });
          }
        })
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
    />
  );
}
