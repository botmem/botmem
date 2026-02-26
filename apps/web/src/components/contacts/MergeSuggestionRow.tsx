import { ContactCard } from './ContactCard';
import { Button } from '../ui/Button';

interface MergeContact {
  id: string;
  displayName: string;
  avatars: Array<{ url: string; source: string }>;
  identifiers: Array<{ type: string; value: string }>;
  connectorSources: string[];
}

interface MergeSuggestionRowProps {
  contact1: MergeContact;
  contact2: MergeContact;
  reason: string;
  onMerge: (targetId: string, sourceId: string) => void;
  onDismiss: (id1: string, id2: string) => void;
}

export function MergeSuggestionRow({ contact1, contact2, reason, onMerge, onDismiss }: MergeSuggestionRowProps) {
  const handleMerge = () => {
    const c1Count = contact1.identifiers?.length || 0;
    const c2Count = contact2.identifiers?.length || 0;
    if (c1Count >= c2Count) {
      onMerge(contact1.id, contact2.id);
    } else {
      onMerge(contact2.id, contact1.id);
    }
  };

  return (
    <div className="border-3 border-nb-border bg-nb-surface-muted p-3">
      <div className="flex items-center gap-2">
        <div className="flex-1">
          <ContactCard contact={contact1} compact />
        </div>
        <span className="font-display text-lg font-bold text-nb-muted shrink-0">↔</span>
        <div className="flex-1">
          <ContactCard contact={contact2} compact />
        </div>
      </div>

      <p className="font-mono text-xs text-nb-muted mt-2">{reason}</p>

      <div className="flex items-center gap-2 mt-2">
        <Button size="sm" onClick={handleMerge}>MERGE</Button>
        <button
          onClick={() => onDismiss(contact1.id, contact2.id)}
          className="border-2 border-nb-border w-7 h-7 flex items-center justify-center font-bold hover:bg-nb-red hover:text-white cursor-pointer text-nb-text text-xs"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
