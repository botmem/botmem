import { useState } from 'react';
import type { Memory } from '@botmem/shared';
import { PageContainer } from '../components/layout/PageContainer';
import { Tabs } from '../components/ui/Tabs';
import { MemorySearchBar } from '../components/memory/MemorySearchBar';
import { MemoryCard } from '../components/memory/MemoryCard';
import { MemoryDetailPanel } from '../components/memory/MemoryDetailPanel';
import { MemoryInsertForm } from '../components/memory/MemoryInsertForm';
import { MemoryGraph } from '../components/memory/MemoryGraph';
import { useMemories } from '../hooks/useMemories';

const tabs = [
  { id: 'search', label: 'SEARCH' },
  { id: 'insert', label: 'INSERT' },
  { id: 'graph', label: 'GRAPH' },
];

export function MemoryExplorerPage() {
  const [activeTab, setActiveTab] = useState('search');
  const handleTabChange = (tab: string) => {
    setActiveTab(tab);
    if (tab === 'graph') loadGraph();
  };
  const [selectedMemory, setSelectedMemory] = useState<Memory | null>(null);
  const { filtered, query, filters, setQuery, setFilters, insertMemory, graphData, loadGraph, loading } = useMemories();

  return (
    <PageContainer>
      <Tabs tabs={tabs} active={activeTab} onChange={handleTabChange} />

      <div className="mt-4">
        {activeTab === 'search' && (
          <div>
            <MemorySearchBar
              query={query}
              onQueryChange={setQuery}
              sourceFilter={filters.source}
              onSourceChange={(s) => setFilters({ source: s })}
              factualityFilter={filters.factuality}
              onFactualityChange={(f) => setFilters({ factuality: f })}
            />

            <div className="mt-4 flex gap-4">
              <div className="flex-1 flex flex-col gap-3">
                <p className="font-mono text-xs text-nb-muted uppercase">
                  {loading ? 'SEARCHING...' : `${filtered.length} memories found`}
                </p>
                {filtered.map((m) => (
                  <MemoryCard
                    key={m.id}
                    memory={m}
                    onClick={() => setSelectedMemory(m)}
                    selected={selectedMemory?.id === m.id}
                  />
                ))}
                {filtered.length === 0 && (
                  <div className="border-3 border-nb-border p-8 text-center bg-nb-surface">
                    <p className="font-display text-xl font-bold uppercase text-nb-text">NO MEMORIES FOUND</p>
                    <p className="font-mono text-sm text-nb-muted mt-2">TRY ADJUSTING YOUR FILTERS</p>
                  </div>
                )}
              </div>

              {selectedMemory && (
                <div className="w-96 shrink-0">
                  <MemoryDetailPanel
                    memory={selectedMemory}
                    onClose={() => setSelectedMemory(null)}
                  />
                </div>
              )}
            </div>
          </div>
        )}

        {activeTab === 'insert' && (
          <div className="max-w-2xl">
            <MemoryInsertForm onInsert={insertMemory} />
          </div>
        )}

        {activeTab === 'graph' && <MemoryGraph data={graphData} />}
      </div>
    </PageContainer>
  );
}
