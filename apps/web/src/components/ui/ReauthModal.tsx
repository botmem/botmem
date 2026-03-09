import { useState } from 'react';
import { Modal } from './Modal';
import { useAuthStore } from '../../store/authStore';
import { useMemoryStore } from '../../store/memoryStore';

interface ReauthModalProps {
  open: boolean;
  onClose: () => void;
}

export function ReauthModal({ open, onClose }: ReauthModalProps) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const reauth = useAuthStore((s) => s.reauth);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await reauth(password);
      // Reset memory store so it reconnects WS and re-fetches everything
      const memStore = useMemoryStore.getState();
      memStore.reset();
      // Trigger full reload: memories, graph, WS subscription, stats
      memStore.connectWs();
      memStore.loadMemories();
      memStore.loadGraph();
      setPassword('');
      onClose();
    } catch (err: any) {
      setError(err.message || 'Authentication failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Unlock Memories">
      <p className="font-mono text-sm text-nb-muted mb-4">
        The server was restarted and your encryption key needs to be restored. Enter your password
        to unlock your memories.
      </p>
      <form onSubmit={handleSubmit}>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Your password"
          autoFocus
          className="w-full border-3 border-nb-border px-4 py-3 font-mono text-sm bg-nb-bg text-nb-text focus:outline-none focus:border-nb-lime placeholder:text-nb-muted"
        />
        {error && <p className="mt-2 font-mono text-xs text-nb-red">{error}</p>}
        <button
          type="submit"
          disabled={loading || !password}
          className="mt-4 w-full py-3 border-3 border-nb-lime bg-nb-lime font-display text-sm font-bold uppercase tracking-wider text-black hover:bg-nb-lime/80 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer transition-colors"
        >
          {loading ? 'Unlocking...' : 'Unlock'}
        </button>
      </form>
    </Modal>
  );
}
