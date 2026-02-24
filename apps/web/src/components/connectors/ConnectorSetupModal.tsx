import { useState, useEffect, useRef, useCallback } from 'react';
import type { ConnectorType, ConnectorManifest } from '@botmem/shared';
import { Modal } from '../ui/Modal';
import { Input } from '../ui/Input';
import { Button } from '../ui/Button';
import { api, createWsConnection, subscribeToChannel } from '../../lib/api';
import { useConnectorStore } from '../../store/connectorStore';

interface ConnectorSetupModalProps {
  open: boolean;
  onClose: () => void;
  connectorType: ConnectorType;
  onConnect: (identifier: string) => void;
}

// Fallback fields when API is not available
const fallbackFields: Record<string, Array<{ name: string; label: string; placeholder: string }>> = {
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
}

interface AuthMethod {
  id: string;
  label: string;
  fields: string[];
}

function schemaToFields(schema: Record<string, any>): SchemaField[] {
  if (!schema?.properties) return [];
  const requiredFields: string[] = schema.required || [];
  return Object.entries(schema.properties).map(([name, prop]: [string, any]) => ({
    name,
    label: prop.title || name,
    placeholder: prop.description || prop.default || '',
    type: prop.type || 'string',
    readOnly: prop.readOnly,
    required: requiredFields.includes(name),
  }));
}

export function ConnectorSetupModal({ open, onClose, connectorType, onConnect }: ConnectorSetupModalProps) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [fields, setFields] = useState<SchemaField[]>([]);
  const [authMethods, setAuthMethods] = useState<AuthMethod[]>([]);
  const [selectedMethod, setSelectedMethod] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [checkingCredentials, setCheckingCredentials] = useState(true);
  const [qrData, setQrData] = useState<string | null>(null);
  const [qrError, setQrError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const manifests = useConnectorStore((s) => s.manifests);

  const isQrAuth = manifests.find((m) => m.id === connectorType)?.authType === 'qr-code';

  // Clean up WebSocket on unmount or close
  const cleanupWs = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
  }, []);

  useEffect(() => {
    return cleanupWs;
  }, [cleanupWs]);

  // For QR code auth, auto-initiate when modal opens
  useEffect(() => {
    if (!open || !isQrAuth) return;

    setLoading(true);
    setQrData(null);
    setQrError(null);

    api.initiateAuth(connectorType, {})
      .then((result) => {
        if (result.type === 'qr-code') {
          setQrData(result.qrData);
          setLoading(false);

          // Subscribe to WebSocket channel for completion
          const ws = createWsConnection();
          wsRef.current = ws;

          ws.onopen = () => {
            subscribeToChannel(ws, result.wsChannel);
          };

          ws.onmessage = (evt) => {
            try {
              const msg = JSON.parse(evt.data);
              if (msg.event === 'auth:complete') {
                cleanupWs();
                onConnect(msg.data.identifier || connectorType);
                onClose();
              } else if (msg.event === 'auth:error') {
                setQrError(msg.data.error || 'Authentication failed');
                cleanupWs();
              }
            } catch {
              // ignore parse errors
            }
          };

          ws.onerror = () => {
            setQrError('WebSocket connection failed');
          };
        }
      })
      .catch((err) => {
        setQrError(err.message || 'Failed to generate QR code');
        setLoading(false);
      });

    return cleanupWs;
  }, [open, isQrAuth, connectorType]);

  // Check for saved credentials (OAuth only)
  useEffect(() => {
    if (isQrAuth) {
      setCheckingCredentials(false);
      return;
    }

    const manifest = manifests.find((m) => m.id === connectorType);
    const isOAuth = manifest?.authType === 'oauth2';

    if (isOAuth) {
      api.hasCredentials(connectorType)
        .then(({ hasSavedCredentials }) => {
          if (hasSavedCredentials) {
            initiateWithSavedCredentials();
          } else {
            setCheckingCredentials(false);
          }
        })
        .catch(() => setCheckingCredentials(false));
    } else {
      setCheckingCredentials(false);
    }
  }, [connectorType, manifests, isQrAuth]);

  useEffect(() => {
    if (isQrAuth) return; // QR auth doesn't need form fields

    const manifest = manifests.find((m) => m.id === connectorType);
    if (manifest?.configSchema) {
      const schema = manifest.configSchema as Record<string, any>;
      setFields(schemaToFields(schema));
      if (schema.authMethods) {
        setAuthMethods(schema.authMethods);
        setSelectedMethod(schema.authMethods[0]?.id || null);
      }
    } else {
      api.getConnectorSchema(connectorType)
        .then(({ schema }) => {
          setFields(schemaToFields(schema));
          if (schema.authMethods) {
            setAuthMethods(schema.authMethods);
            setSelectedMethod(schema.authMethods[0]?.id || null);
          }
        })
        .catch(() => {
          const fb = fallbackFields[connectorType] || [];
          setFields(fb.map((f) => ({ ...f, type: 'string', required: true })));
        });
    }
  }, [connectorType, manifests, isQrAuth]);

  const initiateWithSavedCredentials = async () => {
    setLoading(true);
    try {
      const result = await api.initiateAuth(connectorType, {
        returnTo: window.location.pathname,
      });
      if (result.type === 'redirect') {
        window.location.href = result.url;
        return;
      }
    } catch {
      setCheckingCredentials(false);
      setLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    try {
      const result = await api.initiateAuth(connectorType, {
        ...values,
        returnTo: window.location.pathname,
      });

      if (result.type === 'redirect') {
        window.location.href = result.url;
        return;
      }

      if (result.type === 'complete') {
        const identifier = Object.values(values)[0] || connectorType;
        onConnect(identifier);
        setValues({});
        onClose();
        return;
      }

      onClose();
    } catch {
      const identifier = Object.values(values)[0] || '';
      if (identifier) {
        onConnect(identifier);
        setValues({});
        onClose();
      }
    } finally {
      setLoading(false);
    }
  };

  // QR code auth UI
  if (isQrAuth) {
    return (
      <Modal open={open} onClose={() => { cleanupWs(); onClose(); }} title={`Connect ${connectorType.toUpperCase()}`}>
        <div className="flex flex-col items-center gap-4 py-4">
          {loading && !qrData && !qrError && (
            <p className="font-mono text-sm text-nb-muted uppercase animate-pulse">
              Generating QR code...
            </p>
          )}

          {qrData && (
            <>
              <p className="font-mono text-xs text-nb-muted uppercase text-center">
                Scan this QR code with WhatsApp on your phone
              </p>
              <div className="bg-white p-3 rounded">
                <img src={qrData} alt="WhatsApp QR Code" className="w-64 h-64" />
              </div>
              <p className="font-mono text-[10px] text-nb-muted text-center">
                Open WhatsApp → Settings → Linked Devices → Link a Device
              </p>
              <div className="flex items-center gap-2 mt-2">
                <div className="w-2 h-2 bg-nb-lime rounded-full animate-pulse" />
                <p className="font-mono text-xs text-nb-muted uppercase">
                  Waiting for scan...
                </p>
              </div>
            </>
          )}

          {qrError && (
            <div className="text-center">
              <p className="font-mono text-sm text-nb-red mb-3">{qrError}</p>
              <Button onClick={() => {
                setQrError(null);
                setLoading(true);
                setQrData(null);
                api.initiateAuth(connectorType, {})
                  .then((result) => {
                    if (result.type === 'qr-code') {
                      setQrData(result.qrData);
                      setLoading(false);
                      const ws = createWsConnection();
                      wsRef.current = ws;
                      ws.onopen = () => subscribeToChannel(ws, result.wsChannel);
                      ws.onmessage = (evt) => {
                        try {
                          const msg = JSON.parse(evt.data);
                          if (msg.event === 'auth:complete') {
                            cleanupWs();
                            onConnect(msg.data.identifier || connectorType);
                            onClose();
                          } else if (msg.event === 'auth:error') {
                            setQrError(msg.data.error || 'Authentication failed');
                            cleanupWs();
                          }
                        } catch {}
                      };
                    }
                  })
                  .catch((err) => {
                    setQrError(err.message || 'Failed to generate QR code');
                    setLoading(false);
                  });
              }}>
                RETRY
              </Button>
            </div>
          )}
        </div>
      </Modal>
    );
  }

  if (checkingCredentials || (loading && checkingCredentials !== false)) {
    return (
      <Modal open={open} onClose={onClose} title={`Connect ${connectorType.toUpperCase()}`}>
        <div className="flex flex-col items-center gap-3 py-6">
          <p className="font-mono text-sm text-nb-muted uppercase">
            {loading ? 'Redirecting to authorization...' : 'Checking saved credentials...'}
          </p>
        </div>
      </Modal>
    );
  }

  // Filter fields based on selected auth method
  const activeMethod = authMethods.find((m) => m.id === selectedMethod);
  const visibleFields = activeMethod
    ? fields.filter((f) => activeMethod.fields.includes(f.name))
    : fields;

  return (
    <Modal open={open} onClose={onClose} title={`Connect ${connectorType.toUpperCase()}`}>
      {authMethods.length > 1 && (
        <div className="flex gap-0 mb-4 border-3 border-nb-border">
          {authMethods.map((method) => (
            <button
              key={method.id}
              type="button"
              onClick={() => { setSelectedMethod(method.id); setValues({}); }}
              className={`flex-1 py-3 px-3 font-display text-sm font-bold uppercase transition-colors cursor-pointer border-r-3 border-nb-border last:border-r-0 ${
                selectedMethod === method.id
                  ? 'bg-nb-lime text-black'
                  : 'bg-nb-surface text-nb-muted hover:text-nb-text hover:bg-nb-border/30'
              }`}
            >
              {method.label}
            </button>
          ))}
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
              value={values[field.name] || ''}
              onChange={(e) => setValues({ ...values, [field.name]: e.target.value })}
              required
            />
          ),
        )}
        <Button type="submit" disabled={loading}>
          {loading ? 'CONNECTING...' : 'CONNECT'}
        </Button>
      </form>
    </Modal>
  );
}
