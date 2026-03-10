import type { Memory } from '@botmem/shared';
import { formatRelative, CONNECTOR_COLORS, truncate } from '@botmem/shared';
import { Card } from '../ui/Card';
import { Badge } from '../ui/Badge';
import { AuthedImage } from '../ui/AuthedImage';
import { useMemoryStore } from '../../store/memoryStore';

const sourceIcons: Record<string, string> = {
  email: '\u2709',
  message: '\uD83D\uDCAC',
  photo: '\uD83D\uDCF7',
  location: '\uD83D\uDCCD',
};

function hasThumbnail(memory: Memory): boolean {
  return (memory.source === 'file' || memory.source === 'photo') && !!memory.metadata?.fileUrl;
}

interface MemoryCardProps {
  memory: Memory;
  onClick: () => void;
  selected?: boolean;
  topResult?: boolean;
}

export function MemoryCard({ memory, onClick, selected, topResult }: MemoryCardProps) {
  const { pinMemory, unpinMemory, recordRecall } = useMemoryStore();

  const handlePinClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (memory.pinned) {
      unpinMemory(memory.id);
    } else {
      pinMemory(memory.id);
    }
  };

  const handleCardClick = () => {
    recordRecall(memory.id);
    onClick();
  };

  return (
    <Card
      hoverable
      onClick={handleCardClick}
      className={`group relative ${selected ? 'border-nb-pink border-4' : ''} ${topResult ? 'border-cyan-400 bg-cyan-500/5' : ''} ${memory.pinned ? 'bg-amber-500/5 border-amber-400' : ''}`}
    >
      <button
        onClick={handlePinClick}
        className={`absolute top-2 right-2 w-7 h-7 border-2 border-nb-border flex items-center justify-center text-sm cursor-pointer transition-all z-10 ${
          memory.pinned
            ? 'bg-amber-400 text-black border-amber-500'
            : 'bg-nb-surface-muted text-nb-muted opacity-0 group-hover:opacity-100 hover:bg-amber-200 hover:text-black'
        }`}
        title={memory.pinned ? 'Unpin memory' : 'Pin memory'}
      >
        {memory.pinned ? '\u{1F4CC}' : '\u{1F4CC}'}
      </button>

      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="flex items-center gap-2">
          <span
            className="w-8 h-8 border-2 border-nb-border flex items-center justify-center text-sm"
            style={{ backgroundColor: CONNECTOR_COLORS[memory.sourceConnector] }}
          >
            {sourceIcons[memory.source]}
          </span>
          <Badge color={CONNECTOR_COLORS[memory.sourceConnector]}>{memory.sourceConnector}</Badge>
        </div>
      </div>

      {hasThumbnail(memory) && (
        <div className="border-2 border-nb-border mb-2 overflow-hidden max-h-72">
          <AuthedImage
            src={`/api/memories/${memory.id}/thumbnail`}
            className="w-full object-cover"
            style={memory.metadata?.width && memory.metadata?.height
              ? { aspectRatio: `${memory.metadata.width} / ${memory.metadata.height}` }
              : { height: '10rem' }}
            loading="lazy"
          />
        </div>
      )}

      <p className="font-mono text-sm mb-3 text-nb-text">{truncate(memory.text, 150)}</p>

      <div className="flex items-center justify-between">
        <span className="font-mono text-xs text-nb-muted">{formatRelative(memory.time)}</span>
        <div className="flex items-center gap-1">
          <span className="font-mono text-xs text-nb-muted uppercase">IMP:</span>
          <div className="w-16 h-2.5 border-2 border-nb-border bg-nb-surface-muted">
            <div
              className="h-full bg-nb-purple"
              style={{ width: `${memory.weights.importance * 100}%` }}
            />
          </div>
        </div>
      </div>
    </Card>
  );
}
