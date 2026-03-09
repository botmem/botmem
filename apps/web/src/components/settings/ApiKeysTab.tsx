import { useState } from 'react';
import { useApiKeys } from '../../hooks/useApiKeys';
import { Button } from '../ui/Button';
import { CreateKeyModal } from './CreateKeyModal';
import { KeyCreatedModal } from './KeyCreatedModal';

const MAX_KEYS = 10;

export function ApiKeysTab() {
  const { keys, loading, error, createKey, revokeKey } = useApiKeys();
  const [showCreate, setShowCreate] = useState(false);
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);

  const activeKeys = keys.filter((k) => !k.revokedAt);

  const handleCreate = async (name: string, expiresAt?: string, memoryBankIds?: string[]) => {
    const rawKey = await createKey(name, expiresAt, memoryBankIds);
    setShowCreate(false);
    setCreatedKey(rawKey);
    return rawKey;
  };

  const handleRevoke = async (id: string) => {
    if (!window.confirm('Revoke this API key? This cannot be undone.')) return;
    setRevoking(id);
    try {
      await revokeKey(id);
    } finally {
      setRevoking(null);
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="font-display text-lg font-bold uppercase tracking-wider text-nb-text">
            API KEYS ({activeKeys.length}/{MAX_KEYS})
          </h2>
          <p className="font-mono text-xs text-nb-muted mt-1">
            Named read-only keys for programmatic access via CLI or agents.
          </p>
        </div>
        <Button onClick={() => setShowCreate(true)} disabled={activeKeys.length >= MAX_KEYS}>
          CREATE KEY
        </Button>
      </div>

      {loading ? (
        <div className="flex flex-col gap-3">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-16 border-3 border-nb-border bg-nb-surface-muted"
              style={{ animation: 'pulse-bar 1.5s ease-in-out infinite' }}
            />
          ))}
        </div>
      ) : error ? (
        <p className="font-mono text-sm text-nb-red">{error}</p>
      ) : activeKeys.length === 0 ? (
        <div className="border-3 border-dashed border-nb-border p-8 text-center">
          <p className="font-mono text-sm text-nb-muted">
            No API keys yet. Create one to use with the CLI or agents.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {activeKeys.map((key) => (
            <div
              key={key.id}
              className="flex items-center justify-between border-3 border-nb-border p-3 bg-nb-surface-muted"
            >
              <div className="flex-1 min-w-0">
                <p className="font-display text-sm font-bold uppercase text-nb-text">{key.name}</p>
                <div className="flex items-center gap-4 mt-1">
                  <span className="font-mono text-xs text-nb-muted">bm_sk_...{key.lastFour}</span>
                  <span className="font-mono text-xs text-nb-muted">
                    Created {new Date(key.createdAt).toLocaleDateString()}
                  </span>
                  <span className="font-mono text-xs text-nb-muted">
                    {key.expiresAt
                      ? `Expires ${new Date(key.expiresAt).toLocaleDateString()}`
                      : 'Never expires'}
                  </span>
                </div>
              </div>
              <Button
                variant="danger"
                size="sm"
                onClick={() => handleRevoke(key.id)}
                disabled={revoking === key.id}
              >
                {revoking === key.id ? '...' : 'REVOKE'}
              </Button>
            </div>
          ))}
        </div>
      )}

      <CreateKeyModal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        onCreate={handleCreate}
      />

      {createdKey && (
        <KeyCreatedModal
          open={!!createdKey}
          onClose={() => setCreatedKey(null)}
          apiKey={createdKey}
        />
      )}
    </div>
  );
}
