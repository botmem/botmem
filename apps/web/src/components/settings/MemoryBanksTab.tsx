import { useEffect, useState } from 'react';
import { useMemoryBankStore, type MemoryBank } from '../../store/memoryBankStore';
import { Button } from '../ui/Button';

export function MemoryBanksTab() {
  const {
    memoryBanks,
    loading,
    loadMemoryBanks,
    createMemoryBank,
    renameMemoryBank,
    deleteMemoryBank,
  } = useMemoryBankStore();
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadMemoryBanks();
  }, []);

  const handleCreate = async () => {
    if (!newName.trim()) return;
    setError(null);
    setCreating(true);
    try {
      await createMemoryBank(newName.trim());
      setNewName('');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Operation failed');
    } finally {
      setCreating(false);
    }
  };

  const handleRename = async (id: string) => {
    if (!editName.trim()) return;
    setError(null);
    try {
      await renameMemoryBank(id, editName.trim());
      setEditingId(null);
      setEditName('');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Operation failed');
    }
  };

  const handleDelete = async (id: string) => {
    setError(null);
    try {
      await deleteMemoryBank(id);
      setConfirmDeleteId(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Operation failed');
    }
  };

  const startEdit = (bank: MemoryBank) => {
    setEditingId(bank.id);
    setEditName(bank.name);
  };

  return (
    <div>
      <h2 className="font-display text-lg font-bold uppercase tracking-wider text-nb-text mb-1">
        MEMORY BANKS
      </h2>
      <p className="font-mono text-xs text-nb-muted mb-6">
        Organize memories into separate banks. Each bank has its own isolated set of memories and
        vectors.
      </p>

      {error && (
        <div className="border-3 border-nb-red bg-nb-surface p-3 mb-4">
          <p className="font-mono text-xs font-bold text-nb-red">{error}</p>
        </div>
      )}

      {/* Create new bank */}
      <div className="flex gap-3 mb-6">
        <input
          type="text"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
          placeholder="NEW BANK NAME"
          className="flex-1 border-3 border-nb-border px-4 py-2.5 font-mono bg-nb-surface text-nb-text focus:outline-none focus:border-nb-lime focus:shadow-nb-sm placeholder:text-nb-muted placeholder:uppercase"
        />
        <Button onClick={handleCreate} disabled={creating || !newName.trim()} size="sm">
          {creating ? 'CREATING...' : 'CREATE'}
        </Button>
      </div>

      {/* Bank list */}
      {loading ? (
        <div className="flex flex-col gap-3">
          {[1, 2].map((_, i) => (
            <div
              key={`skel-bank-${i}`}
              className="h-16 border-3 border-nb-border bg-nb-surface-muted"
              style={{ animation: 'pulse-bar 1.5s ease-in-out infinite' }}
            />
          ))}
        </div>
      ) : memoryBanks.length === 0 ? (
        <p className="font-mono text-sm text-nb-muted">No memory banks found.</p>
      ) : (
        <div className="flex flex-col gap-3">
          {memoryBanks.map((bank) => (
            <div
              key={bank.id}
              className="border-3 border-nb-border bg-nb-surface p-4 flex items-center justify-between gap-4"
            >
              <div className="flex-1 min-w-0">
                {editingId === bank.id ? (
                  <div className="flex gap-2 items-center">
                    <input
                      type="text"
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleRename(bank.id);
                        if (e.key === 'Escape') {
                          setEditingId(null);
                          setEditName('');
                        }
                      }}
                      className="flex-1 border-3 border-nb-lime px-3 py-1.5 font-mono text-sm bg-nb-surface text-nb-text focus:outline-none"
                    />
                    <button
                      onClick={() => handleRename(bank.id)}
                      className="font-display text-xs font-bold uppercase border-2 border-nb-border px-2 py-1 text-nb-text hover:bg-nb-lime hover:text-black transition-colors cursor-pointer"
                    >
                      SAVE
                    </button>
                    <button
                      onClick={() => {
                        setEditingId(null);
                        setEditName('');
                      }}
                      className="font-display text-xs font-bold uppercase border-2 border-nb-border px-2 py-1 text-nb-muted hover:bg-nb-surface-hover transition-colors cursor-pointer"
                    >
                      CANCEL
                    </button>
                  </div>
                ) : (
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-display text-sm font-bold uppercase tracking-wider text-nb-text truncate">
                        {bank.name}
                      </span>
                      {bank.isDefault === true && (
                        <span className="font-mono text-[10px] font-bold uppercase tracking-wider bg-nb-lime text-black px-1.5 py-0.5 border-2 border-nb-border">
                          DEFAULT
                        </span>
                      )}
                    </div>
                    <div className="flex gap-4 mt-1">
                      <span className="font-mono text-xs text-nb-muted">
                        {bank.memoryCount} {bank.memoryCount === 1 ? 'memory' : 'memories'}
                      </span>
                      <span className="font-mono text-xs text-nb-muted">
                        Created {new Date(bank.createdAt).toLocaleDateString()}
                      </span>
                    </div>
                  </div>
                )}
              </div>

              {editingId !== bank.id && (
                <div className="flex gap-2 shrink-0">
                  <button
                    onClick={() => startEdit(bank)}
                    className="font-display text-xs font-bold uppercase border-2 border-nb-border px-2.5 py-1.5 text-nb-text hover:bg-nb-lime hover:text-black transition-colors cursor-pointer"
                  >
                    RENAME
                  </button>
                  {!bank.isDefault && (
                    <>
                      {confirmDeleteId === bank.id ? (
                        <div className="flex gap-1">
                          <button
                            onClick={() => handleDelete(bank.id)}
                            className="font-display text-xs font-bold uppercase border-2 border-nb-red px-2.5 py-1.5 bg-nb-red text-white hover:opacity-80 transition-colors cursor-pointer"
                          >
                            CONFIRM
                          </button>
                          <button
                            onClick={() => setConfirmDeleteId(null)}
                            className="font-display text-xs font-bold uppercase border-2 border-nb-border px-2.5 py-1.5 text-nb-muted hover:bg-nb-surface-hover transition-colors cursor-pointer"
                          >
                            CANCEL
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => setConfirmDeleteId(bank.id)}
                          className="font-display text-xs font-bold uppercase border-2 border-nb-border px-2.5 py-1.5 text-nb-red hover:bg-nb-red hover:text-white transition-colors cursor-pointer"
                        >
                          DELETE
                        </button>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
