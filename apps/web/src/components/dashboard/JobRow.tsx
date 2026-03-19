import type { Job } from '@botmem/shared';
import { CONNECTOR_COLORS } from '@botmem/shared';
import { StatusIndicator } from './StatusIndicator';
import { ProgressBar } from '../ui/ProgressBar';
import { Button } from '../ui/Button';

interface JobRowProps {
  job: Job;
  onCancel: (id: string) => void;
  onMove: (id: string, dir: 'up' | 'down') => void;
}

export function JobRow({ job, onCancel, onMove }: JobRowProps) {
  const canCancel = job.status === 'running' || job.status === 'queued';
  const canMove = job.status === 'queued';

  return (
    <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3 border-b-3 border-nb-border p-3 last:border-b-0">
      {/* Top row on mobile: ID + connector + status */}
      <div className="flex items-center gap-3 sm:contents">
        <span className="font-mono text-xs text-nb-muted w-16 shrink-0">{job.id.slice(0, 8)}</span>
        <div className="w-28 shrink-0">
          <span
            className="font-mono text-xs font-bold uppercase block"
            style={{ color: CONNECTOR_COLORS[job.connector] }}
          >
            {job.connector}
          </span>
          {job.accountIdentifier && (
            <span
              className="font-mono text-[11px] text-nb-muted block truncate"
              title={job.accountIdentifier}
            >
              {job.accountIdentifier}
            </span>
          )}
        </div>
        <div className="w-24 shrink-0">
          <StatusIndicator status={job.status} />
        </div>
      </div>
      {/* Progress / error */}
      <div className="flex-1 min-w-0">
        {(job.status === 'running' || job.status === 'done') && (
          <div className="flex items-center gap-2">
            <ProgressBar
              value={Math.min(job.progress, job.total)}
              max={job.total}
              color={CONNECTOR_COLORS[job.connector]}
              className="flex-1"
            />
            <span className="font-mono text-xs shrink-0 text-nb-text">
              {Math.min(job.progress, job.total)}/{job.total}
            </span>
          </div>
        )}
        {job.status === 'failed' && (
          <span className="font-mono text-xs text-nb-red">{job.error}</span>
        )}
      </div>
      {/* Actions */}
      <div className="flex items-center gap-1 shrink-0">
        {canMove && (
          <>
            <button
              onClick={() => onMove(job.id, 'up')}
              className="border-2 border-nb-border size-9 sm:size-7 flex items-center justify-center font-bold text-xs hover:bg-nb-lime hover:text-black cursor-pointer text-nb-text"
            >
              ↑
            </button>
            <button
              onClick={() => onMove(job.id, 'down')}
              className="border-2 border-nb-border size-9 sm:size-7 flex items-center justify-center font-bold text-xs hover:bg-nb-lime hover:text-black cursor-pointer text-nb-text"
            >
              ↓
            </button>
          </>
        )}
        {canCancel && (
          <Button size="sm" variant="danger" onClick={() => onCancel(job.id)}>
            CANCEL
          </Button>
        )}
      </div>
    </div>
  );
}
