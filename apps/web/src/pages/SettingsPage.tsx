import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { PageContainer } from '../components/layout/PageContainer';
import { Card } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { Toggle } from '../components/ui/Toggle';
import { Tabs } from '../components/ui/Tabs';
import { ApiKeysTab } from '../components/settings/ApiKeysTab';
import { useAuth } from '../hooks/useAuth';
import { api } from '../lib/api';

const TABS = [
  { id: 'profile', label: 'Profile' },
  { id: 'api-keys', label: 'API Keys' },
  { id: 'pipeline', label: 'Pipeline' },
];

const CONCURRENCY_SETTINGS = [
  {
    key: 'sync_concurrency',
    label: 'SYNC CONCURRENCY',
    description: 'Number of connector sync jobs that run in parallel.',
    min: 1,
    max: 10,
    default: '2',
  },
  {
    key: 'embed_concurrency',
    label: 'EMBED CONCURRENCY',
    description: 'Number of embedding jobs processed simultaneously.',
    min: 1,
    max: 20,
    default: '5',
  },
  {
    key: 'enrich_concurrency',
    label: 'ENRICH CONCURRENCY',
    description: 'Number of enrichment jobs processed simultaneously.',
    min: 1,
    max: 20,
    default: '3',
  },
];

export function SettingsPage() {
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = searchParams.get('tab') || 'profile';

  const [settings, setSettings] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [autoEnrich, setAutoEnrich] = useState(true);
  const [confirmPurge, setConfirmPurge] = useState(false);

  useEffect(() => {
    api
      .getSettings()
      .then((data) => {
        setSettings(data);
        if (data.auto_enrich !== undefined) setAutoEnrich(data.auto_enrich !== 'false');
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  const handleTabChange = (id: string) => {
    setSearchParams({ tab: id });
  };

  const handleChange = (key: string, value: string) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
    setSaved(false);
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const patch: Record<string, string> = {};
      for (const s of CONCURRENCY_SETTINGS) {
        if (settings[s.key] !== undefined) {
          patch[s.key] = settings[s.key];
        }
      }
      patch.auto_enrich = String(autoEnrich);
      const updated = await api.updateSettings(patch);
      setSettings(updated);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <PageContainer>
      <h1 className="font-display text-3xl font-bold uppercase tracking-wider text-nb-text mb-6">
        SETTINGS
      </h1>

      <Tabs tabs={TABS} active={activeTab} onChange={handleTabChange} />

      <div className="mt-6 flex flex-col gap-6">
        {activeTab === 'profile' && (
          <Card>
            <h2 className="font-display text-lg font-bold uppercase tracking-wider text-nb-text mb-1">
              PROFILE
            </h2>
            <p className="font-mono text-xs text-nb-muted mb-4">
              Your account information.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Input
                label="Name"
                value={user?.name || ''}
                disabled
                className="opacity-70"
              />
              <Input
                label="Email"
                value={user?.email || ''}
                disabled
                className="opacity-70"
              />
            </div>
          </Card>
        )}

        {activeTab === 'api-keys' && (
          <Card>
            <ApiKeysTab />
          </Card>
        )}

        {activeTab === 'pipeline' && (
          <>
            <Card>
              <h2 className="font-display text-lg font-bold uppercase tracking-wider text-nb-text mb-1">
                PIPELINE CONCURRENCY
              </h2>
              <p className="font-mono text-xs text-nb-muted mb-6">
                Controls how many jobs run in parallel for each pipeline stage. Higher values process
                faster but use more resources.
              </p>

              {loading ? (
                <div className="flex flex-col gap-3">
                  {[1, 2, 3].map((i) => (
                    <div key={i} className="h-10 border-3 border-nb-border bg-nb-surface-muted" style={{ animation: 'pulse-bar 1.5s ease-in-out infinite' }} />
                  ))}
                </div>
              ) : (
                <div className="flex flex-col gap-5">
                  {CONCURRENCY_SETTINGS.map((setting) => (
                    <div key={setting.key} className="flex items-center justify-between gap-4">
                      <div className="flex-1">
                        <label className="font-display text-sm font-bold uppercase tracking-wider text-nb-text">
                          {setting.label}
                        </label>
                        <p className="font-mono text-xs text-nb-muted mt-0.5">{setting.description}</p>
                      </div>
                      <input
                        type="number"
                        min={setting.min}
                        max={setting.max}
                        value={settings[setting.key] ?? setting.default}
                        onChange={(e) => handleChange(setting.key, e.target.value)}
                        className="border-3 border-nb-border bg-nb-surface font-mono text-nb-text px-3 py-2 w-20 text-center focus:outline-none focus:border-nb-lime focus:shadow-nb-sm"
                      />
                    </div>
                  ))}

                  <div className="border-t-3 border-nb-border pt-4 mt-1">
                    <Toggle
                      checked={autoEnrich}
                      onChange={setAutoEnrich}
                      label="AUTO-ENRICH NEW MEMORIES"
                    />
                    <p className="font-mono text-xs text-nb-muted mt-1 ml-14">
                      Automatically extract entities and claims from newly ingested memories.
                    </p>
                  </div>

                  <div className="flex items-center gap-4 mt-2">
                    <Button onClick={handleSave} disabled={saving}>
                      {saving ? 'SAVING...' : 'SAVE'}
                    </Button>
                    {saved && (
                      <span className="font-mono text-sm font-bold text-nb-green">SAVED</span>
                    )}
                    {error && (
                      <span className="font-mono text-sm font-bold text-nb-red">{error}</span>
                    )}
                  </div>
                </div>
              )}
            </Card>

            <Card className="border-nb-red">
              <h2 className="font-display text-lg font-bold uppercase tracking-wider text-nb-red mb-1">
                DANGER ZONE
              </h2>
              <p className="font-mono text-xs text-nb-muted mb-4">
                Irreversible actions. Think twice.
              </p>

              <div className="flex flex-col gap-3">
                <div className="flex items-center justify-between border-3 border-nb-border p-3 bg-nb-surface-muted">
                  <div>
                    <p className="font-display text-sm font-bold uppercase text-nb-text">PURGE ALL MEMORIES</p>
                    <p className="font-mono text-xs text-nb-muted">Delete all memories, embeddings, and raw events.</p>
                  </div>
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => {
                      if (confirmPurge) {
                        api.purgeMemories().catch(() => {});
                        setConfirmPurge(false);
                      } else {
                        setConfirmPurge(true);
                        setTimeout(() => setConfirmPurge(false), 3000);
                      }
                    }}
                  >
                    {confirmPurge ? 'CONFIRM' : 'PURGE'}
                  </Button>
                </div>

                <div className="flex items-center justify-between border-3 border-nb-border p-3 bg-nb-surface-muted">
                  <div>
                    <p className="font-display text-sm font-bold uppercase text-nb-text">RESET VECTOR INDEX</p>
                    <p className="font-mono text-xs text-nb-muted">Rebuild the Qdrant collection from scratch.</p>
                  </div>
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => api.resetVectorIndex().catch(() => {})}
                  >
                    RESET
                  </Button>
                </div>
              </div>
            </Card>
          </>
        )}
      </div>
    </PageContainer>
  );
}
