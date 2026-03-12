import { useState } from 'react';
import { Modal } from './Modal';
import { useAuthStore } from '../../store/authStore';
import { useMemoryStore } from '../../store/memoryStore';

interface ReauthModalProps {
  open: boolean;
  onClose: () => void;
}

export function ReauthModal({ open, onClose }: ReauthModalProps) {
  const [recoveryKey, setRecoveryKey] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const submitRecoveryKey = useAuthStore((s) => s.submitRecoveryKey);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await submitRecoveryKey(recoveryKey.trim());
      // Reset memory store so it reconnects WS and re-fetches everything
      const memStore = useMemoryStore.getState();
      memStore.reset();
      memStore.connectWs();
      memStore.loadMemories();
      memStore.loadGraph();
      setRecoveryKey('');
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Invalid recovery key');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Unlock Memories">
      <p className="font-mono text-sm text-nb-muted mb-4">
        Enter the recovery key you saved when you created your account to access your memories.
      </p>
      <form onSubmit={handleSubmit}>
        <textarea
          data-ph-mask
          value={recoveryKey}
          onChange={(e) => setRecoveryKey(e.target.value)}
          placeholder="Paste your recovery key here"
          rows={2}
          className="w-full border-3 border-nb-border px-4 py-3 font-mono text-sm bg-nb-bg text-nb-text focus:outline-none focus:border-nb-lime placeholder:text-nb-muted resize-none"
        />
        {error && <p className="mt-2 font-mono text-xs text-nb-red">{error}</p>}
        <button
          type="submit"
          disabled={loading || !recoveryKey.trim()}
          className="mt-4 w-full py-3 border-3 border-nb-lime bg-nb-lime font-display text-sm font-bold uppercase tracking-wider text-black hover:bg-nb-lime/80 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer transition-colors"
        >
          {loading ? 'Unlocking...' : 'Unlock'}
        </button>
      </form>
    </Modal>
  );
}
