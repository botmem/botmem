import { useEffect, useState } from 'react';
import { PageContainer } from '../components/layout/PageContainer';
import { Card } from '../components/ui/Card';
import { Tabs } from '../components/ui/Tabs';
import { ReauthModal } from '../components/ui/ReauthModal';
import { ConnectorLogFeed } from '../components/dashboard/ConnectorLogFeed';
import { JobTable } from '../components/dashboard/JobTable';
import { PipelineView } from '../components/dashboard/PipelineView';
import { MemoryGraph } from '../components/memory/MemoryGraph';
import { useJobs } from '../hooks/useJobs';
import { useConnectors } from '../hooks/useConnectors';
import { useMemories } from '../hooks/useMemories';
import { useJobStore } from '../store/jobStore';
import { useMemoryBankStore } from '../store/memoryBankStore';

const dashTabs = [
  { id: 'overview', label: 'OVERVIEW' },
  { id: 'logs', label: 'LOGS' },
];

export function DashboardPage() {
  const { jobs, logs, queueStats, cancelJob, reprioritize, clearLogs } = useJobs();
  const { accounts } = useConnectors();
  const { graphData, loadGraph, memoryStats } = useMemories();
  const { retrying, retryAllFailed } = useJobStore();
  const activeMemoryBankId = useMemoryBankStore((s) => s.activeMemoryBankId);
  const [activeTab, setActiveTab] = useState('overview');
  const [reauthOpen, setReauthOpen] = useState(false);

  useEffect(() => {
    loadGraph();
  }, [activeMemoryBankId]);

  const totalMemories = memoryStats?.total ?? 0;
  const activeConnectors = accounts.filter(
    (a) => a.status === 'connected' || a.status === 'syncing',
  ).length;
  // Pending = items waiting/active in the processing pipeline (clean/embed/enrich)
  // Delayed sync jobs (retrying) are shown here too so nothing is invisible
  const pipelinePending = queueStats
    ? Object.values(queueStats).reduce(
        (sum, s) => sum + (s.waiting ?? 0) + (s.active ?? 0) + (s.delayed ?? 0),
        0,
      )
    : 0;

  // Failed = BullMQ permanently-failed jobs across all queues — single source of truth
  const failedJobs = queueStats
    ? Object.values(queueStats).reduce((sum, s) => sum + (s.failed ?? 0), 0)
    : 0;

  const stats = [
    { label: 'TOTAL MEMORIES', value: totalMemories.toLocaleString(), color: '#C4F53A' },
    { label: 'PENDING', value: pipelinePending.toLocaleString(), color: '#FF6B9D' },
    { label: 'CONNECTORS', value: String(activeConnectors), color: '#4ECDC4' },
    { label: 'FAILED JOBS', value: String(failedJobs), color: '#EF4444' },
  ];

  return (
    <PageContainer>
      <ReauthModal open={reauthOpen} onClose={() => setReauthOpen(false)} />
      <Tabs tabs={dashTabs} active={activeTab} onChange={setActiveTab} />

      <div className="mt-4" style={{ minHeight: 560 }}>
        {activeTab === 'overview' && (
          <>
            {/* Graph FIRST */}
            <div className="mb-6 relative">
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
                    Enter your recovery key to unlock your data
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
              <MemoryGraph data={graphData} onReload={loadGraph} />
            </div>

            {/* Metrics cards */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
              {stats.map((s) => (
                <Card key={s.label} className="p-0 overflow-hidden">
                  <div
                    className="px-4 py-1.5 font-display text-xs font-bold uppercase tracking-wider text-black"
                    style={{ backgroundColor: s.color }}
                  >
                    {s.label}
                  </div>
                  <div className="px-4 py-4 flex items-center justify-between">
                    <p className="font-display text-4xl font-bold text-nb-text">{s.value}</p>
                    {s.label === 'FAILED JOBS' && failedJobs > 0 && (
                      <button
                        onClick={retryAllFailed}
                        disabled={retrying}
                        className="font-mono text-[10px] font-bold uppercase px-2 py-1 border-2 border-nb-red text-nb-red cursor-pointer hover:bg-nb-red hover:text-black transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {retrying ? 'RETRYING...' : 'RETRY ALL'}
                      </button>
                    )}
                  </div>
                </Card>
              ))}
            </div>

            {/* Pipeline view */}
            {queueStats && (
              <div className="mb-6">
                <PipelineView queueStats={queueStats} />
              </div>
            )}
          </>
        )}

        {activeTab === 'logs' && (
          <div className="flex flex-col gap-6">
            <div className="overflow-x-auto">
              <JobTable jobs={jobs} onCancel={cancelJob} onMove={reprioritize} />
            </div>
            <ConnectorLogFeed logs={logs} onClear={clearLogs} />
          </div>
        )}
      </div>
    </PageContainer>
  );
}
