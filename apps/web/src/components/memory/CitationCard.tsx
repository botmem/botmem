import type { ApiMemoryItem } from '../../lib/api';

interface CitationCardProps {
  index: number;
  citation: ApiMemoryItem;
  onClick?: () => void;
}

export function CitationCard({ index, citation, onClick }: CitationCardProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full border border-nb-border/50 bg-nb-surface/50 p-2 text-left cursor-pointer hover:border-nb-lime transition-colors"
    >
      <div className="flex items-center gap-2 mb-1">
        <span className="font-mono text-[11px] font-bold text-nb-lime">[{index + 1}]</span>
        {citation.connectorType && (
          <span className="font-mono text-[11px] uppercase text-nb-muted">
            {citation.connectorType}
          </span>
        )}
        {citation.eventTime && (
          <span className="font-mono text-[11px] text-nb-muted">
            {new Date(citation.eventTime).toLocaleDateString()}
          </span>
        )}
      </div>
      {citation.text && (
        <p className="font-mono text-xs text-nb-text line-clamp-2">{citation.text}</p>
      )}
    </button>
  );
}
