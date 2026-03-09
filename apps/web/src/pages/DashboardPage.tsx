import { useEffect, useState } from 'react';
import { PageContainer } from '../components/layout/PageContainer';
import { Card } from '../components/ui/Card';
import { Tabs } from '../components/ui/Tabs';
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
      <Tabs tabs={dashTabs} active={activeTab} onChange={setActiveTab} />

      {memoryStats?.needsRelogin && (
        <div className="mt-4 px-5 py-4 border-2 border-yellow-400 bg-yellow-400/20 font-display text-base text-yellow-300 text-center">
          <span className="text-xl mr-2">&#x1F512;</span>
          Your encryption key is not loaded. Please{' '}
          <button
            onClick={() => {
              localStorage.clear();
              window.location.href = '/login';
            }}
            className="underline font-bold cursor-pointer text-yellow-100 hover:text-white"
          >
            log out and log back in
          </button>{' '}
          to decrypt your memories.
        </div>
      )}

      <div className="mt-4" style={{ minHeight: 560 }}>
        {activeTab === 'overview' && (
          <>
            {/* Graph FIRST */}
            <div className="mb-6">
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
