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
import { api } from '../lib/api';

const dashTabs = [
  { id: 'overview', label: 'OVERVIEW' },
  { id: 'logs', label: 'LOGS' },
];

export function DashboardPage() {
  const { jobs, logs, queueStats, cancelJob, reprioritize, clearLogs, fetchJobs, fetchQueueStats } = useJobs();
  const { accounts } = useConnectors();
  const { graphData, loadGraph } = useMemories();
  const [memoryStats, setMemoryStats] = useState<{ total: number; bySource: Record<string, number>; byConnector: Record<string, number> } | null>(null);
  const [activeTab, setActiveTab] = useState('overview');

  useEffect(() => {
    loadGraph();
    api.getMemoryStats().then(setMemoryStats).catch(() => {});
    // Poll memory stats at the same 3s cadence as queue stats (via useJobs)
    const interval = setInterval(() => {
      api.getMemoryStats().then(setMemoryStats).catch(() => {});
    }, 3000);
    return () => { clearInterval(interval); };
  }, []);

  const totalMemories = memoryStats?.total ?? 0;
  const activeConnectors = accounts.filter((a) => a.status === 'connected' || a.status === 'syncing').length;
  const failedSyncJobs = jobs.filter((j) => j.status === 'failed').length;
  const failedPipeline = queueStats
    ? Object.values(queueStats).reduce((sum, s) => sum + (s.failed ?? 0), 0)
    : 0;
  const failedJobs = failedSyncJobs + failedPipeline;

  // Pending = items still in BullMQ queues (waiting + active + delayed) across pipeline stages
  const pipelinePending = queueStats
    ? Object.entries(queueStats)
        .filter(([name]) => name !== 'sync')
        .reduce((sum, [, s]) => sum + (s.waiting ?? 0) + (s.active ?? 0) + (s.delayed ?? 0), 0)
    : 0;

  const stats = [
    { label: 'TOTAL MEMORIES', value: totalMemories.toLocaleString(), color: '#C4F53A' },
    { label: 'PENDING', value: pipelinePending.toLocaleString(), color: '#FF6B9D' },
    { label: 'CONNECTORS', value: String(activeConnectors), color: '#4ECDC4' },
    { label: 'FAILED JOBS', value: String(failedJobs), color: '#EF4444' },
  ];

  return (
    <PageContainer>
      {/* Tabs: Overview / Logs */}
      <Tabs tabs={dashTabs} active={activeTab} onChange={setActiveTab} />

      <div className="mt-4" style={{ minHeight: 560 }}>
        {activeTab === 'overview' && (
          <>
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
                        onClick={() => {
                          api.retryFailedJobs().then(() => { fetchJobs(); fetchQueueStats(); }).catch(() => {});
                        }}
                        className="font-mono text-[10px] font-bold uppercase px-2 py-1 border-2 border-nb-red text-nb-red cursor-pointer hover:bg-nb-red hover:text-black transition-colors"
                      >
                        RETRY ALL
                      </button>
                    )}
                  </div>
                </Card>
              ))}
            </div>

            {queueStats && (
              <div className="mb-6">
                <PipelineView queueStats={queueStats} />
              </div>
            )}

            <JobTable
              jobs={jobs}
              onCancel={cancelJob}
              onMove={reprioritize}
            />
          </>
        )}

        {activeTab === 'logs' && (
          <ConnectorLogFeed logs={logs} onClear={clearLogs} />
        )}
      </div>

      {/* Graph */}
      <div className="mt-6">
        <MemoryGraph data={graphData} onReload={loadGraph} />
      </div>
    </PageContainer>
  );
}
