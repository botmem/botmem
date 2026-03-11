import { useState } from 'react';
import type { Memory } from '@botmem/shared';
import { cn } from '@/lib/utils';
import { Card } from '../ui/Card';
import { ImageLightbox } from '../ui/ImageLightbox';
import { MemoryDetailCore } from './MemoryDetailCore';
import { useMemoryStore } from '../../store/memoryStore';

interface MemoryDetailPanelProps {
  memory: Memory;
  onClose: () => void;
}

export function MemoryDetailPanel({ memory, onClose }: MemoryDetailPanelProps) {
  const { pinMemory, unpinMemory } = useMemoryStore();
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);

  const handlePinClick = () => {
    if (memory.pinned) {
      unpinMemory(memory.id);
    } else {
      pinMemory(memory.id);
    }
  };

  return (
    <Card className="sticky top-6">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <h3 className="font-display text-lg font-bold uppercase text-nb-text">Memory Detail</h3>
          <button
            onClick={handlePinClick}
            className={cn(
              'border-2 border-nb-border size-8 flex items-center justify-center text-sm cursor-pointer transition-all',
              memory.pinned
                ? 'bg-amber-400 text-black border-amber-500'
                : 'bg-nb-surface-muted text-nb-muted hover:bg-amber-200 hover:text-black',
            )}
            title={memory.pinned ? 'Unpin memory' : 'Pin memory'}
          >
            {'\u{1F4CC}'}
          </button>
        </div>
        <button
          onClick={onClose}
          className="border-2 border-nb-border size-8 flex items-center justify-center font-bold hover:bg-nb-red hover:text-white cursor-pointer text-nb-text"
        >
          X
        </button>
      </div>

      {memory.pinned && (
        <div className="mb-3 px-2 py-1 bg-amber-400/20 border-2 border-amber-400 text-xs font-mono uppercase text-amber-600">
          Pinned - Score floor 0.75, no recency decay
        </div>
      )}

      <MemoryDetailCore
        id={memory.id}
        source={memory.source}
        sourceConnector={memory.sourceConnector}
        text={memory.text}
        eventTime={memory.time}
        ingestTime={memory.ingestTime}
        weights={memory.weights}
        entities={memory.entities}
        claims={memory.claims}
        metadata={memory.metadata}
        showTimestamps
        showClaims
        onThumbnailClick={setLightboxSrc}
      />
      {lightboxSrc && <ImageLightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />}
    </Card>
  );
}
