import { useEffect, useReducer, useRef, useCallback } from 'react';
import type { ConnectorType } from '@botmem/shared';
import { Modal } from '../ui/Modal';
import { Input } from '../ui/Input';
import { Button } from '../ui/Button';
import { api, createWsConnection, subscribeToChannel } from '../../lib/api';
import { useConnectorStore } from '../../store/connectorStore';
import { isFirebaseMode } from '../../store/authStore';

const FIREBASE_HIDDEN_FIELDS = new Set(['clientId', 'clientSecret']);

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

function schemaToFields(schema: Record<string, any>): SchemaField[] {
  if (!schema?.properties) return [];
  const requiredFields: string[] = schema.required || [];
  return Object.entries(schema.properties).map(([name, prop]: [string, any]) => ({
    name,
    label: prop.title || name,
    placeholder: prop.description || '',
    type: prop.type || 'string',
    readOnly: prop.readOnly,
    required: requiredFields.includes(name),
    default: prop.default,
  }));
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
        if (result.type === 'qr-code') {
          dispatch({ type: 'QR_RECEIVED', qrData: result.qrData });
          const ws = createWsConnection();
          wsRef.current = ws;
          ws.onopen = () => subscribeToChannel(ws, result.wsChannel);
          ws.onmessage = (evt) => {
            try {
              const msg = JSON.parse(evt.data);
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
              <img src={state.qrData} alt="WhatsApp QR Code" className="w-64 h-64" />
            </div>
            <p className="font-mono text-[10px] text-nb-muted text-center">
              Open WhatsApp → Settings → Linked Devices → Link a Device
            </p>
            <div className="flex items-center gap-2 mt-2">
              <div className="w-2 h-2 bg-nb-lime rounded-full animate-pulse" />
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
        onConnect(account?.identifier || connectorType);
        dispatch({ type: 'RESET_VALUES' });
        onClose();
        return;
      }

      const result = await api.initiateAuth(connectorType, {
        ...state.values,
        returnTo: window.location.pathname,
      });

      if (result.type === 'redirect') {
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
              className={`flex-1 py-3 px-3 font-display text-sm font-bold uppercase transition-colors cursor-pointer border-r-3 border-nb-border last:border-r-0 ${
                state.selectedMethod === method.id
                  ? 'bg-nb-lime text-black'
                  : 'bg-nb-surface text-nb-muted hover:text-nb-text hover:bg-nb-border/30'
              }`}
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

  const isQrAuth = manifests.find((m) => m.id === connectorType)?.authType === 'qr-code';

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
        if (result.type === 'qr-code') {
          dispatch({ type: 'QR_RECEIVED', qrData: result.qrData });
          const ws = createWsConnection();
          wsRef.current = ws;
          ws.onopen = () => subscribeToChannel(ws, result.wsChannel);
          ws.onmessage = (evt) => {
            try {
              const msg = JSON.parse(evt.data);
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
    if (isQrAuth) {
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
                if (result.type === 'redirect') window.location.href = result.url;
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
  }, [connectorType, manifests, isQrAuth]);

  // Load form schema
  useEffect(() => {
    if (isQrAuth) return;

    const manifest = manifests.find((m) => m.id === connectorType);
    if (manifest?.configSchema) {
      const schema = manifest.configSchema as Record<string, any>;
      dispatch({
        type: 'SET_FIELDS',
        fields: schemaToFields(schema),
        authMethods: schema.authMethods,
      });
    } else {
      api
        .getConnectorSchema(connectorType)
        .then(({ schema }) => {
          dispatch({
            type: 'SET_FIELDS',
            fields: schemaToFields(schema),
            authMethods: schema.authMethods,
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
  }, [connectorType, manifests, isQrAuth]);

  if (!open) return null;

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
