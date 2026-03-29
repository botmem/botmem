import { useEffect, useRef, useMemo, useState, lazy, Suspense } from 'react';
import { PageContainer } from '../components/layout/PageContainer';
import { Card } from '../components/ui/Card';
import { AnimatedNumber } from '../components/ui/AnimatedNumber';
import { Tabs } from '../components/ui/Tabs';
import { SearchInput } from '../components/ui/SearchInput';
import { ReauthModal } from '../components/ui/ReauthModal';
const MemoryGraph = lazy(() =>
  import('../components/memory/MemoryGraph').then((m) => ({ default: m.MemoryGraph })),
);
const TimelineView = lazy(() =>
  import('../components/memory/TimelineView').then((m) => ({ default: m.TimelineView })),
);
import { ConnectorStatusBar } from '../components/dashboard/ConnectorStatusBar';
import { useConnectors } from '../hooks/useConnectors';
import { useMemories } from '../hooks/useMemories';
import { useSearch } from '../hooks/useSearch';
import { useJobStore } from '../store/jobStore';
import { useMemoryStore, apiMemoryToShared } from '../store/memoryStore';
import { useMemoryBankStore } from '../store/memoryBankStore';
import { useTourStore } from '../store/tourStore';
import { api } from '../lib/api';
import { Button } from '../components/ui/Button';

const dashTabs = [
  { id: 'overview', label: 'OVERVIEW' },
  { id: 'timeline', label: 'TIMELINE' },
];

export function DashboardPage() {
  const { accounts } = useConnectors();
  const {
    graphData,
    loadGraph,
    loadFullGraph,
    loadGraphForIds,
    graphPreview,
    graphLoading,
    memoryStats,
  } = useMemories();
  const timelineMemories = useMemoryStore((s) => s.memories);
  const timelineLoading = useMemoryStore((s) => s.loading);
  const loadMemories = useMemoryStore((s) => s.loadMemories);
  const [activeTab, setActiveTab] = useState('overview');
  const [reauthOpen, setReauthOpen] = useState(false);

  // Connect WebSocket for notifications
  useEffect(() => {
    useJobStore.getState().connectWs();
  }, []);

  // Auto-open ReauthModal when server detects stale/missing DEK
  useEffect(() => {
    if (memoryStats?.needsRecoveryKey) setReauthOpen(true);
  }, [memoryStats?.needsRecoveryKey]);

  // Demo data banner
  const demoMode = useTourStore((s) => s.demoMode);
  const [hasDemoData, setHasDemoData] = useState(false);
  const [clearingDemo, setClearingDemo] = useState(false);
  const [demoBannerDismissed, setDemoBannerDismissed] = useState(false);

  useEffect(() => {
    if (!demoMode) return;
    api
      .getDemoStatus()
      .then((s) => setHasDemoData(s.hasDemoData))
      .catch(() => {});
  }, [demoMode]);

  const handleClearDemo = async () => {
    setClearingDemo(true);
    try {
      await api.clearDemoData();
      setHasDemoData(false);
      useTourStore.getState().startTour(false); // clear demoMode
      // Refresh all dashboard data after demo cleanup
      loadGraph();
      loadMemories();
      // Re-fetch memory stats (total memories, connectors count, etc.)
      const bankId = useMemoryBankStore.getState().activeMemoryBankId;
      api
        .getMemoryStats({ memoryBankId: bankId || undefined })
        .then((stats) => useMemoryStore.setState({ memoryStats: stats }))
        .catch(() => {});
    } catch {
      // ignore
    } finally {
      setClearingDemo(false);
    }
  };

  const graphSearch = useSearch({
    onResults: (results) => {
      // Load graph for exactly the search-matched memory IDs
      const ids = Array.from(results.memoryIds);
      if (ids.length > 0) loadGraphForIds(ids);
    },
    onClear: () => {
      // Restore preview graph when search is cleared
      loadGraph();
    },
  });

  const searchInputRef = useRef<HTMLInputElement>(null);

  // When search has results, convert to Memory[] for the timeline view
  const searchTimelineMemories = useMemo(
    () => graphSearch.results?.items.map(apiMemoryToShared) ?? null,
    [graphSearch.results],
  );

  // Load graph once when stats become available (initial mount)
  const initialGraphLoaded = useRef(false);
  useEffect(() => {
    if (memoryStats != null && !initialGraphLoaded.current) {
      initialGraphLoaded.current = true;
      loadGraph();
    }
  }, [memoryStats, loadGraph]);

  // Load memories when timeline tab is activated (only if store is empty)
  useEffect(() => {
    if (activeTab === 'timeline' && timelineMemories.length === 0 && !timelineLoading) {
      loadMemories();
    }
  }, [activeTab, timelineMemories.length, timelineLoading, loadMemories]);

  // Reload graph when the user switches memory banks (event-driven via Zustand subscribe)
  useEffect(() => {
    let prevBankId = useMemoryBankStore.getState().activeMemoryBankId;
    return useMemoryBankStore.subscribe((state) => {
      if (state.activeMemoryBankId !== prevBankId) {
        prevBankId = state.activeMemoryBankId;
        loadGraph();
      }
    });
  }, [loadGraph]);

  const totalMemories = memoryStats?.total ?? 0;
  const activeConnectors = accounts.filter(
    (a) => a.status === 'connected' || a.status === 'syncing',
  ).length;

  const stats = [
    { label: 'TOTAL MEMORIES', value: totalMemories, color: 'var(--color-nb-lime)' },
    { label: 'CONNECTORS', value: activeConnectors, color: 'var(--color-nb-blue)' },
  ];

  return (
    <PageContainer>
      <ReauthModal open={reauthOpen} onClose={() => setReauthOpen(false)} />
      <Tabs tabs={dashTabs} active={activeTab} onChange={setActiveTab} />

      {/* Persistent search — visible on overview + timeline tabs */}
      <div className="mt-4" data-tour="search-bar">
        <SearchInput
          value={graphSearch.term}
          onChange={graphSearch.setTerm}
          pending={graphSearch.pending}
          placeholder="SEARCH MEMORIES..."
          inputRef={searchInputRef}
        />
      </div>

      {hasDemoData && !demoBannerDismissed && (
        <div className="mt-4 border-3 border-nb-border bg-amber-100 dark:bg-yellow-950/40 px-4 py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <p className="font-mono text-sm text-amber-900 dark:text-yellow-200">
            You're viewing demo data. Delete it when you're ready to connect your real accounts.
          </p>
          <div className="flex items-center gap-2 shrink-0">
            <Button size="sm" variant="danger" disabled={clearingDemo} onClick={handleClearDemo}>
              {clearingDemo ? 'DELETING...' : 'DELETE DEMO DATA'}
            </Button>
            <button
              onClick={() => setDemoBannerDismissed(true)}
              className="font-mono text-xs text-nb-muted hover:text-nb-text cursor-pointer transition-colors px-1"
              aria-label="Dismiss demo data banner"
            >
              X
            </button>
          </div>
        </div>
      )}

      <div
        className="mt-4 min-h-[20rem] sm:min-h-[35rem] flex flex-col"
        style={{ height: activeTab === 'timeline' ? 'calc(100dvh - 10rem)' : undefined }}
      >
        {activeTab === 'overview' && (
          <>
            {/* Graph FIRST */}
            <div className="mb-6 relative" data-tour="dashboard-graph">
              {memoryStats?.needsRecoveryKey && (
                <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-nb-bg/80 backdrop-blur-sm">
                  <svg
                    width="40"
                    height="40"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="text-nb-text"
                  >
                    <rect x="3" y="11" width="18" height="11" rx="0" />
                    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                  </svg>
                  <p className="font-display text-sm text-nb-muted text-center max-w-xs">
                    Enter your recovery key to access your data
                  </p>
                  <button
                    onClick={() => setReauthOpen(true)}
                    aria-label="Unlock encryption key"
                    className="px-4 py-2 border-2 border-nb-lime bg-nb-lime/20 font-display text-xs font-bold uppercase tracking-wider text-nb-lime hover:bg-nb-lime/40 cursor-pointer transition-colors"
                  >
                    Unlock
                  </button>
                </div>
              )}
              <Suspense
                fallback={
                  <div className="h-64 flex items-center justify-center text-nb-muted font-mono text-sm">
                    Loading graph...
                  </div>
                }
              >
                <MemoryGraph
                  data={graphData}
                  onReloadPreview={loadGraph}
                  graphPreview={graphPreview}
                  graphLoading={graphLoading}
                  onLoadAll={loadFullGraph}
                  search={graphSearch}
                  searchInputRef={searchInputRef}
                />
              </Suspense>
            </div>

            {/* Metrics cards */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
              {stats.map((s) => (
                <Card key={s.label} className="p-0 overflow-hidden">
                  <div
                    className="px-4 py-1.5 font-display text-xs font-bold uppercase tracking-wider text-black"
                    style={{ backgroundColor: s.color }}
                  >
                    {s.label}
                  </div>
                  <div className="px-4 py-4 flex items-center justify-between">
                    <AnimatedNumber
                      value={s.value}
                      className="font-display text-4xl font-bold text-nb-text"
                    />
                  </div>
                </Card>
              ))}
            </div>

            {/* Connector sync status */}
            <ConnectorStatusBar />
          </>
        )}

        {activeTab === 'timeline' && (
          <Suspense
            fallback={
              <div className="h-64 flex items-center justify-center text-nb-muted font-mono text-sm">
                Loading timeline...
              </div>
            }
          >
            <TimelineView
              memories={searchTimelineMemories ?? timelineMemories}
              loading={graphSearch.pending || (!searchTimelineMemories && timelineLoading)}
            />
          </Suspense>
        )}
      </div>
    </PageContainer>
  );
}
