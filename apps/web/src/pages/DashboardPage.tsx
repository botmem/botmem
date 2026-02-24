import { useEffect, useState } from 'react';
import { PageContainer } from '../components/layout/PageContainer';
import { Card } from '../components/ui/Card';
import { ConnectorLogFeed } from '../components/dashboard/ConnectorLogFeed';
import { PipelineLogFeed } from '../components/dashboard/PipelineLogFeed';
import { JobTable } from '../components/dashboard/JobTable';
import { useJobs } from '../hooks/useJobs';
import { useConnectors } from '../hooks/useConnectors';
import { api } from '../lib/api';

export function DashboardPage() {
  const { jobs, logs, queueStats, cancelJob, reprioritize } = useJobs();
  const { accounts } = useConnectors();
  const [memoryStats, setMemoryStats] = useState<{ total: number; bySource: Record<string, number>; byConnector: Record<string, number> } | null>(null);

  useEffect(() => {
    const fetchStats = () => {
      api.getMemoryStats().then(setMemoryStats).catch(() => {});
    };
    fetchStats();
    const interval = setInterval(fetchStats, 10000);
    return () => clearInterval(interval);
  }, []);

  const totalMemories = memoryStats?.total ?? 0;

  // Today's count: memories created today
  // We'll derive from the stats API — for now show total by connector as a proxy
  // until we add a today filter. The API already gives us bySource/byConnector.
  const activeConnectors = accounts.filter((a) => a.status === 'connected' || a.status === 'syncing').length;
  const failedJobs = jobs.filter((j) => j.status === 'failed').length;

  // Embed queue pending
  const embedPending = queueStats ? (queueStats.embed?.waiting ?? 0) + (queueStats.embed?.active ?? 0) + (queueStats.embed?.delayed ?? 0) : 0;

  const stats = [
    { label: 'TOTAL MEMORIES', value: totalMemories.toLocaleString(), color: '#C4F53A' },
    { label: 'EMBED QUEUE', value: embedPending.toLocaleString(), color: '#FF6B9D' },
    { label: 'ACTIVE CONNECTORS', value: String(activeConnectors), color: '#4ECDC4' },
    { label: 'FAILED JOBS', value: String(failedJobs), color: '#EF4444' },
  ];

  return (
    <PageContainer>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        {stats.map((s) => (
          <Card key={s.label} className="text-center p-4" style={{ borderLeftColor: s.color, borderLeftWidth: '6px' }}>
            <p className="font-display text-3xl font-bold text-nb-text">{s.value}</p>
            <p className="font-mono text-xs text-nb-muted uppercase mt-1">{s.label}</p>
          </Card>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
        <ConnectorLogFeed logs={logs} />
        <div className="flex flex-col gap-4">
          <JobTable
            jobs={jobs}
            onCancel={cancelJob}
            onMove={reprioritize}
          />
          {queueStats && (
            <Card className="p-0 overflow-hidden">
              <div className="bg-nb-black text-white px-4 py-2 font-display text-sm font-bold uppercase">
                PIPELINE QUEUES
              </div>
              <div className="p-3 grid grid-cols-2 gap-2">
                {Object.entries(queueStats).map(([name, s]) => {
                  const total = s.waiting + s.active + s.delayed;
                  return (
                    <div key={name} className="border-2 border-nb-border p-2">
                      <p className="font-display text-xs font-bold uppercase text-nb-text">{name}</p>
                      <div className="font-mono text-[10px] text-nb-muted mt-1 space-y-0.5">
                        {s.active > 0 && (
                          <p><span className="text-nb-lime font-bold">{s.active}</span> active</p>
                        )}
                        {s.waiting > 0 && (
                          <p><span className="text-nb-yellow font-bold">{s.waiting.toLocaleString()}</span> waiting</p>
                        )}
                        {s.delayed > 0 && (
                          <p><span className="text-nb-muted font-bold">{s.delayed}</span> delayed</p>
                        )}
                        {s.failed > 0 && (
                          <p><span className="text-nb-red font-bold">{s.failed}</span> failed</p>
                        )}
                        {s.completed > 0 && (
                          <p><span className="text-nb-muted">{s.completed.toLocaleString()}</span> done</p>
                        )}
                        {total === 0 && s.completed === 0 && s.failed === 0 && (
                          <p className="text-nb-muted">idle</p>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </Card>
          )}
        </div>
      </div>

      {/* Full-width pipeline activity log */}
      <PipelineLogFeed logs={logs} />
    </PageContainer>
  );
}
