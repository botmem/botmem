import { useState, useMemo } from 'react';
import type { Memory } from '@botmem/shared';
import { formatDate } from '@botmem/shared';
import { StreamGraph } from './StreamGraph';
import { TimelineMemoryItem } from './TimelineMemoryItem';
import { MemoryDetailSidebar } from './MemoryDetailSidebar';

interface TimelineViewProps {
  memories: Memory[];
  loading: boolean;
}

export function TimelineView({ memories, loading }: TimelineViewProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedMemory = memories.find((m) => m.id === selectedId) || null;

  // Group memories by day
  const dayGroups = useMemo(() => {
    const groups = new Map<string, Memory[]>();
    for (const m of memories) {
      const day = (m.time || '').slice(0, 10) || 'Unknown';
      if (!groups.has(day)) groups.set(day, []);
      groups.get(day)!.push(m);
    }
    // Sort days descending
    return [...groups.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  }, [memories]);

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Stream Graph — full width, above the list+sidebar row */}
      <div className="h-36 border-b-2 border-nb-border shrink-0">
        <StreamGraph memories={memories} className="h-full" />
      </div>

      {/* Timeline list + Detail sidebar row */}
      <div className="flex flex-1 overflow-hidden min-h-0">
        {/* Left: Day-grouped Timeline */}
        <div className="flex-1 overflow-y-auto min-w-0">
          {loading && (
            <div className="p-4 font-mono text-xs text-nb-muted uppercase">Loading...</div>
          )}
          {!loading && memories.length === 0 && (
            <div className="p-8 text-center font-mono text-sm text-nb-muted">
              No memories found. Try a search query.
            </div>
          )}
          {dayGroups.map(([day, mems]) => (
            <div key={day}>
              <div className="sticky top-0 z-10 px-3 py-1.5 border-b-2 border-nb-border bg-nb-bg font-display text-[11px] font-bold uppercase tracking-wider text-nb-muted">
                {day === 'Unknown' ? 'Unknown Date' : formatDate(day + 'T00:00:00')}
                <span className="ml-2 text-nb-text">{mems.length}</span>
              </div>
              {mems.map((m) => (
                <TimelineMemoryItem
                  key={m.id}
                  memory={m}
                  selected={selectedId === m.id}
                  onClick={() => setSelectedId(m.id)}
                />
              ))}
            </div>
          ))}
        </div>

        {/* Right: Detail Panel — only beside the timeline list, not the stream graph */}
        {selectedMemory && (
          <aside className="hidden lg:flex w-96 shrink-0">
            <MemoryDetailSidebar memory={selectedMemory} onClose={() => setSelectedId(null)} />
          </aside>
        )}
      </div>
    </div>
  );
}
