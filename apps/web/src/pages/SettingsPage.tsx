import { useEffect, useState } from 'react';
import { PageContainer } from '../components/layout/PageContainer';
import { Card } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { api } from '../lib/api';

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
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .getSettings()
      .then((data) => setSettings(data))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

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

      <Card>
        <h2 className="font-display text-lg font-bold uppercase tracking-wider text-nb-text mb-1">
          PIPELINE CONCURRENCY
        </h2>
        <p className="font-mono text-xs text-nb-muted mb-6">
          Controls how many jobs run in parallel for each pipeline stage. Higher values process
          faster but use more resources.
        </p>

        {loading ? (
          <p className="font-mono text-sm text-nb-muted">Loading...</p>
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
                  className="border-3 border-nb-border bg-nb-surface font-mono text-nb-text px-3 py-2 w-20 text-center"
                />
              </div>
            ))}

            <div className="flex items-center gap-4 mt-2">
              <Button onClick={handleSave} disabled={saving}>
                {saving ? 'SAVING...' : 'SAVE'}
              </Button>
              {saved && (
                <span className="font-mono text-sm font-bold text-green-600">Saved!</span>
              )}
              {error && (
                <span className="font-mono text-sm font-bold text-nb-red">{error}</span>
              )}
            </div>
          </div>
        )}
      </Card>
    </PageContainer>
  );
}
