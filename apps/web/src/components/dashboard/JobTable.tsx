import { useState, useMemo } from 'react';
import type { Job, JobStatus } from '@botmem/shared';
import { CONNECTOR_COLORS, STATUS_COLORS } from '@botmem/shared';
import { JobRow } from './JobRow';
import { Card } from '../ui/Card';

const STATUSES: JobStatus[] = ['running', 'queued', 'done', 'failed', 'cancelled'];

interface JobTableProps {
  jobs: Job[];
  onCancel: (id: string) => void;
  onMove: (id: string, dir: 'up' | 'down') => void;
}

export function JobTable({ jobs, onCancel, onMove }: JobTableProps) {
  // Default: hide cancelled
  const [statusFilter, setStatusFilter] = useState<Set<string>>(
    new Set(['running', 'queued', 'done', 'failed']),
  );
  const [connectorFilter, setConnectorFilter] = useState<Set<string>>(new Set());

  const connectors = useMemo(() => {
    const set = new Set<string>();
    for (const j of jobs) if (j.connector) set.add(j.connector);
    return Array.from(set).sort();
  }, [jobs]);

  const filtered = useMemo(() => {
    return jobs.filter((j) => {
      if (!statusFilter.has(j.status)) return false;
      if (connectorFilter.size > 0 && !connectorFilter.has(j.connector)) return false;
      return true;
    });
  }, [jobs, statusFilter, connectorFilter]);

  const toggleStatus = (status: string) => {
    setStatusFilter((prev) => {
      const next = new Set(prev);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });
  };

  const toggleConnector = (conn: string) => {
    setConnectorFilter((prev) => {
      const next = new Set(prev);
      if (next.has(conn)) next.delete(conn);
      else next.add(conn);
      return next;
    });
  };

  const runningCount = jobs.filter((j) => j.status === 'running').length;

  return (
    <Card className="p-0 overflow-hidden">
      <div className="bg-nb-black text-white px-4 py-2 font-display text-sm font-bold uppercase flex items-center justify-between">
        <span>JOB QUEUE</span>
        <span className="font-mono text-xs">
          {runningCount > 0 ? `${runningCount} RUNNING` : `${filtered.length} JOBS`}
        </span>
      </div>

      {/* Filters */}
      <div className="px-3 py-2 border-b-2 border-nb-border bg-nb-surface flex flex-wrap items-center gap-1.5">
        {/* Status toggles */}
        {STATUSES.map((status) => {
          const count = jobs.filter((j) => j.status === status).length;
          if (count === 0) return null;
          return (
            <button
              key={status}
              onClick={() => toggleStatus(status)}
              className="font-mono text-[10px] font-bold uppercase px-2 py-0.5 border-2 cursor-pointer transition-colors"
              style={{
                borderColor: STATUS_COLORS[status],
                backgroundColor: statusFilter.has(status) ? STATUS_COLORS[status] : 'transparent',
                color: statusFilter.has(status) ? 'var(--color-nb-black)' : STATUS_COLORS[status],
                opacity: statusFilter.has(status) ? 1 : 0.5,
              }}
            >
              {status} ({count})
            </button>
          );
        })}

        {/* Separator + Connector toggles */}
        {connectors.length > 1 && (
          <>
            <div className="w-px h-4 bg-nb-border mx-1" />
            {connectors.map((conn) => (
              <button
                key={conn}
                onClick={() => toggleConnector(conn)}
                className="font-mono text-[10px] font-bold uppercase px-2 py-0.5 border-2 cursor-pointer transition-colors"
                style={{
                  borderColor: CONNECTOR_COLORS[conn] || 'var(--color-nb-muted)',
                  backgroundColor:
                    connectorFilter.size === 0 || connectorFilter.has(conn)
                      ? CONNECTOR_COLORS[conn] || 'var(--color-nb-muted)'
                      : 'transparent',
                  color:
                    connectorFilter.size === 0 || connectorFilter.has(conn)
                      ? 'var(--color-nb-black)'
                      : CONNECTOR_COLORS[conn] || 'var(--color-nb-muted)',
                  opacity: connectorFilter.size === 0 || connectorFilter.has(conn) ? 1 : 0.5,
                }}
              >
                {conn}
              </button>
            ))}
          </>
        )}
      </div>

      <div className="overflow-y-auto max-h-[calc(100dvh-16rem)] sm:max-h-[calc(100dvh-20rem)]">
        {filtered.map((job, idx) => (
          <JobRow key={`${job.id}-${idx}`} job={job} onCancel={onCancel} onMove={onMove} />
        ))}
        {filtered.length === 0 && (
          <div className="py-8 text-center">
            <span className="inline-block text-2xl mb-2 opacity-30">[ ]</span>
            <p className="font-display text-sm font-bold uppercase text-nb-muted">
              {jobs.length === 0 ? 'NO JOBS IN QUEUE' : 'NO MATCHING JOBS'}
            </p>
          </div>
        )}
      </div>
    </Card>
  );
}
