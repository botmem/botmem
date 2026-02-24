import type { Memory } from '@botmem/shared';
import { formatRelative, CONNECTOR_COLORS, truncate } from '@botmem/shared';
import { Card } from '../ui/Card';
import { Badge } from '../ui/Badge';
import { FactualityBadge } from './FactualityBadge';

const sourceIcons: Record<string, string> = {
  email: '✉',
  message: '💬',
  photo: '📷',
  location: '📍',
};

interface MemoryCardProps {
  memory: Memory;
  onClick: () => void;
  selected?: boolean;
}

export function MemoryCard({ memory, onClick, selected }: MemoryCardProps) {
  return (
    <Card
      hoverable
      onClick={onClick}
      className={selected ? 'border-nb-pink border-4' : ''}
    >
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="flex items-center gap-2">
          <span
            className="w-8 h-8 border-2 border-nb-border flex items-center justify-center text-sm"
            style={{ backgroundColor: CONNECTOR_COLORS[memory.sourceConnector] }}
          >
            {sourceIcons[memory.source]}
          </span>
          <Badge color={CONNECTOR_COLORS[memory.sourceConnector]}>
            {memory.sourceConnector}
          </Badge>
        </div>
        <FactualityBadge label={memory.factuality.label} />
      </div>

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
