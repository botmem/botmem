import { useState } from 'react';
import { Modal } from '../ui/Modal';
import { Input } from '../ui/Input';
import { Button } from '../ui/Button';

interface CreateKeyModalProps {
  open: boolean;
  onClose: () => void;
  onCreate: (name: string, expiresAt?: string) => Promise<string>;
}

const EXPIRY_OPTIONS = [
  { label: 'Never', value: '' },
  { label: '7 days', days: 7 },
  { label: '30 days', days: 30 },
  { label: '60 days', days: 60 },
  { label: '90 days', days: 90 },
  { label: '1 year', days: 365 },
  { label: 'Custom...', value: 'custom' },
] as const;

function addDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

export function CreateKeyModal({ open, onClose, onCreate }: CreateKeyModalProps) {
  const [name, setName] = useState('');
  const [expiryChoice, setExpiryChoice] = useState('');
  const [customDate, setCustomDate] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const computeExpiry = (): string | undefined => {
    if (!expiryChoice) return undefined;
    if (expiryChoice === 'custom') {
      return customDate ? new Date(customDate).toISOString() : undefined;
    }
    const option = EXPIRY_OPTIONS.find((o) => 'days' in o && String(o.days) === expiryChoice);
    if (option && 'days' in option) return addDays(option.days);
    return undefined;
  };

  const handleCreate = async () => {
    setCreating(true);
    setError(null);
    try {
      await onCreate(name, computeExpiry());
    } catch (err: any) {
      setError(err.message);
    } finally {
      setCreating(false);
    }
  };

  const handleClose = () => {
    setName('');
    setExpiryChoice('');
    setCustomDate('');
    setError(null);
    onClose();
  };

  return (
    <Modal open={open} onClose={handleClose} title="CREATE API KEY">
      <div className="flex flex-col gap-4">
        <Input
          label="Key Name"
          placeholder="e.g. cli-agent, my-bot"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
        />
        <div>
          <label className="font-display text-xs font-bold uppercase tracking-wider text-nb-text block mb-1.5">
            Expiration
          </label>
          <select
            value={expiryChoice}
            onChange={(e) => setExpiryChoice(e.target.value)}
            className="appearance-none border-3 border-nb-border bg-nb-surface font-mono text-sm uppercase text-nb-text px-4 py-3 w-full focus:outline-none focus:border-nb-lime focus:shadow-nb-sm cursor-pointer bg-[url('data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2212%22%20height%3D%2212%22%20viewBox%3D%220%200%2012%2012%22%3E%3Cpath%20fill%3D%22%23888%22%20d%3D%22M6%208L1%203h10z%22%2F%3E%3C%2Fsvg%3E')] bg-no-repeat bg-[right_12px_center]"
          >
            {EXPIRY_OPTIONS.map((opt) => (
              <option key={'days' in opt ? opt.days : opt.value} value={'days' in opt ? String(opt.days) : opt.value}>
                {opt.label.toUpperCase()}
              </option>
            ))}
          </select>
        </div>
        {expiryChoice === 'custom' && (
          <div>
            <label className="font-display text-xs font-bold uppercase tracking-wider text-nb-text block mb-1.5">
              Custom Date
            </label>
            <input
              type="date"
              value={customDate}
              min={new Date().toISOString().split('T')[0]}
              onChange={(e) => setCustomDate(e.target.value)}
              className="border-3 border-nb-border bg-nb-surface font-mono text-sm uppercase text-nb-text px-4 py-3 w-full focus:outline-none focus:border-nb-lime focus:shadow-nb-sm"
            />
          </div>
        )}
        {error && (
          <p className="font-mono text-xs text-nb-red">{error}</p>
        )}
        <div className="flex gap-3 justify-end">
          <Button variant="ghost" onClick={handleClose}>CANCEL</Button>
          <Button onClick={handleCreate} disabled={!name.trim() || creating}>
            {creating ? 'CREATING...' : 'CREATE'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
