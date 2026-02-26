import { useState, useEffect } from 'react';
import { formatDate } from '@botmem/shared';
import { Card } from '../ui/Card';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { api } from '../../lib/api';
import { IDENTIFIER_COLORS } from './constants';

interface ContactDetailPanelProps {
  contact: {
    id: string;
    displayName: string;
    avatars: Array<{ url: string; source: string }>;
    identifiers: Array<{ id: string; type: string; value: string; isPrimary: boolean }>;
    connectorSources: string[];
  };
  onClose: () => void;
  onUpdate: (id: string, data: { displayName?: string }) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}

export function ContactDetailPanel({ contact, onClose, onUpdate, onDelete }: ContactDetailPanelProps) {
  const [editName, setEditName] = useState(contact.displayName);
  const [memories, setMemories] = useState<any[]>([]);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    setEditName(contact.displayName);
    setConfirmDelete(false);
    api.getContactMemories(contact.id).then(setMemories).catch(() => setMemories([]));
  }, [contact.id]);

  const handleNameSave = () => {
    if (editName.trim() && editName !== contact.displayName) {
      onUpdate(contact.id, { displayName: editName.trim() });
    }
  };

  const handleDelete = () => {
    if (confirmDelete) {
      onDelete(contact.id);
    } else {
      setConfirmDelete(true);
    }
  };

  return (
    <Card className="sticky top-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-display text-lg font-bold uppercase text-nb-text">Contact Detail</h3>
        <button
          onClick={onClose}
          className="border-2 border-nb-border w-8 h-8 flex items-center justify-center font-bold hover:bg-nb-red hover:text-white cursor-pointer text-nb-text"
        >
          X
        </button>
      </div>

      <div className="flex flex-col gap-4">
        {/* Avatar gallery */}
        {contact.avatars.length > 0 && (
          <div className="flex gap-2 flex-wrap">
            {contact.avatars.map((av, i) => (
              <div key={i} className="flex flex-col items-center">
                <img
                  src={av.url}
                  alt={contact.displayName}
                  className="border-3 border-nb-border w-16 h-16 object-cover"
                />
                <span className="font-mono text-[10px] text-nb-muted mt-0.5">{av.source}</span>
              </div>
            ))}
          </div>
        )}

        {/* Editable name */}
        <div>
          <label className="font-display text-xs font-bold uppercase tracking-wider text-nb-muted">Display Name</label>
          <input
            type="text"
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            onBlur={handleNameSave}
            onKeyDown={(e) => e.key === 'Enter' && handleNameSave()}
            className="mt-1 w-full border-3 border-nb-border bg-nb-surface font-mono text-sm text-nb-text px-3 py-2"
          />
        </div>

        {/* Identifiers */}
        <div>
          <h4 className="font-display text-xs font-bold uppercase mb-2 text-nb-text">Identifiers</h4>
          <div className="flex flex-col gap-1.5">
            {contact.identifiers.map((ident) => (
              <div key={ident.id} className="flex items-center gap-2">
                <Badge color={IDENTIFIER_COLORS[ident.type]} className="text-[10px] py-0 shrink-0">
                  {ident.type}
                </Badge>
                <span className="font-mono text-xs text-nb-text truncate">{ident.value}</span>
                {ident.isPrimary && (
                  <span className="font-mono text-[10px] text-nb-muted">PRIMARY</span>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Linked memories */}
        <div>
          <h4 className="font-display text-xs font-bold uppercase mb-2 text-nb-text">
            Linked Memories ({memories.length})
          </h4>
          <div className="flex flex-col gap-1 max-h-60 overflow-y-auto">
            {memories.length === 0 && (
              <p className="font-mono text-xs text-nb-muted">No linked memories</p>
            )}
            {memories.map((m: any) => (
              <div key={m.id} className="border-2 border-nb-border p-2 bg-nb-surface-muted">
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="font-mono text-[10px] text-nb-muted">{formatDate(m.eventTime || m.createdAt)}</span>
                  <Badge className="text-[10px] py-0">{m.connectorType}</Badge>
                </div>
                <p className="font-mono text-xs text-nb-text line-clamp-2">{m.text}</p>
              </div>
            ))}
          </div>
        </div>

        {/* Delete */}
        <Button variant="danger" size="sm" onClick={handleDelete}>
          {confirmDelete ? 'CONFIRM DELETE' : 'DELETE CONTACT'}
        </Button>
      </div>
    </Card>
  );
}
