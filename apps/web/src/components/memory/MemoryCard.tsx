import type { Memory } from '@botmem/shared';
import { formatRelative, CONNECTOR_COLORS, truncate } from '@botmem/shared';
import { cn } from '@/lib/utils';
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

const ENTITY_COLORS: Record<string, { text: string; border: string }> = {
  PERSON: { text: 'text-nb-pink', border: 'border-nb-pink/30' },
  PLACE: { text: 'text-nb-blue', border: 'border-nb-blue/30' },
  ORG: { text: 'text-nb-purple', border: 'border-nb-purple/30' },
  DATE: { text: 'text-nb-yellow', border: 'border-nb-yellow/30' },
};

const DEFAULT_ENTITY_COLOR = { text: 'text-nb-gray', border: 'border-nb-gray/30' };

const FACTUALITY_COLORS: Record<string, string> = {
  FACT: 'bg-nb-green',
  UNVERIFIED: 'bg-nb-yellow',
  FICTION: 'bg-nb-red',
};

function hasThumbnail(memory: Memory): boolean {
  return (memory.source === 'file' || memory.source === 'photo') && !!memory.metadata?.fileUrl;
}

/** Heuristic: text that is still encrypted (base64 ciphertext, no spaces). */
function looksEncrypted(text: string | null | undefined): boolean {
  if (!text || text.length < 32) return false;
  return /^[A-Za-z0-9+/=]{32,}$/.test(text.trim());
}

function getInitials(displayName: string): string {
  const words = displayName.trim().split(/\s+/);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return (words[0]?.[0] || '?').toUpperCase();
}

interface MemoryCardProps {
  memory: Memory;
  onClick: () => void;
  selected?: boolean;
  topResult?: boolean;
}

export function MemoryCard({ memory, onClick, selected, topResult }: MemoryCardProps) {
  const pinMemory = useMemoryStore((s) => s.pinMemory);
  const unpinMemory = useMemoryStore((s) => s.unpinMemory);
  const recordRecall = useMemoryStore((s) => s.recordRecall);

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

  const entities = Array.isArray(memory.entities) ? memory.entities : [];
  const people = Array.isArray(memory.people) ? memory.people : [];
  const factualityLabel = memory.factuality?.label || 'UNVERIFIED';
  const score = memory.weights?.final ?? memory.weights?.importance ?? 0;

  const visibleEntities = entities.slice(0, 5);
  const extraEntityCount = entities.length - 5;

  const visiblePeople = people.slice(0, 3);
  const extraPeopleCount = people.length - 3;

  return (
    <Card
      hoverable
      onClick={handleCardClick}
      data-memory-id={memory.id}
      className={cn(
        'group relative',
        selected && 'border-nb-pink border-4',
        topResult && 'border-cyan-400 bg-cyan-500/5',
        memory.pinned && 'bg-amber-500/5 border-amber-400',
      )}
    >
      {/* Pin button */}
      <button
        onClick={handlePinClick}
        className={cn(
          'absolute top-2 right-8 size-7 border-2 border-nb-border flex items-center justify-center text-sm cursor-pointer transition-all z-10',
          memory.pinned
            ? 'bg-amber-400 text-black border-amber-500'
            : 'bg-nb-surface-muted text-nb-muted opacity-0 group-hover:opacity-100 hover:bg-amber-200 hover:text-black',
        )}
        title={memory.pinned ? 'Unpin memory' : 'Pin memory'}
      >
        {'\u{1F4CC}'}
      </button>

      {/* Factuality badge */}
      <div
        className={cn(
          'absolute top-3 right-3 w-2 h-2',
          FACTUALITY_COLORS[factualityLabel] || 'bg-nb-yellow',
        )}
        title={factualityLabel}
      />

      {/* Header: connector icon + badge */}
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="flex items-center gap-2">
          <span
            className="size-8 border-2 border-nb-border flex items-center justify-center text-sm"
            style={{ backgroundColor: CONNECTOR_COLORS[memory.sourceConnector] }}
          >
            {sourceIcons[memory.source]}
          </span>
          <Badge color={CONNECTOR_COLORS[memory.sourceConnector]}>{memory.sourceConnector}</Badge>
        </div>
      </div>

      {/* Thumbnail */}
      {hasThumbnail(memory) && (
        <div className="border-2 border-nb-border mb-2 overflow-hidden max-h-72">
          <AuthedImage
            src={`/api/memories/${memory.id}/thumbnail`}
            className="w-full object-cover"
            style={
              memory.metadata?.width && memory.metadata?.height
                ? { aspectRatio: `${memory.metadata.width} / ${memory.metadata.height}` }
                : { height: '10rem' }
            }
            loading="lazy"
          />
        </div>
      )}

      {/* Text excerpt */}
      {!(hasThumbnail(memory) && looksEncrypted(memory.text)) && (
        <p data-ph-mask className="font-mono text-sm mb-2 text-nb-text">
          {truncate(memory.text, 150)}
        </p>
      )}

      {/* Entity tags */}
      {visibleEntities.length > 0 && (
        <div className="mb-2">
          {visibleEntities.map((entity, i) => {
            const entityType = typeof entity === 'string' ? 'default' : entity.type || 'default';
            const entityValue = typeof entity === 'string' ? entity : entity.value;
            const colors = ENTITY_COLORS[entityType.toUpperCase()] || DEFAULT_ENTITY_COLOR;
            return (
              <span
                key={`${entityValue}-${i}`}
                className={cn(
                  'border text-[11px] font-mono px-1.5 py-0.5 inline-block mr-1 mb-1',
                  'border-nb-border/50',
                  colors.text,
                  colors.border,
                )}
              >
                {entityValue}
              </span>
            );
          })}
          {extraEntityCount > 0 && (
            <span className="text-[11px] font-mono text-nb-muted inline-block mr-1 mb-1">
              +{extraEntityCount} more
            </span>
          )}
        </div>
      )}

      {/* People row */}
      {visiblePeople.length > 0 && (
        <div className="flex items-center gap-1 mb-2">
          {visiblePeople.map((person, i) => (
            <div
              key={`${person.personId || person.displayName}-${i}`}
              className="w-5 h-5 bg-nb-surface-muted border border-nb-border/50 flex items-center justify-center text-[8px] font-mono text-nb-muted"
              title={`${person.displayName} (${person.role})`}
            >
              {getInitials(person.displayName)}
            </div>
          ))}
          {extraPeopleCount > 0 && (
            <span className="text-[8px] font-mono text-nb-muted">+{extraPeopleCount}</span>
          )}
        </div>
      )}

      {/* Footer: timestamp + score */}
      <div className="flex items-center justify-between">
        <span className="font-mono text-xs text-nb-muted">{formatRelative(memory.time)}</span>
        <span className="text-[11px] font-mono text-nb-muted">{score.toFixed(2)}</span>
      </div>
    </Card>
  );
}
