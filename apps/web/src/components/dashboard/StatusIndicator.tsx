import { cn } from '@botmem/shared';

interface StatusIndicatorProps {
  status: string;
}

const statusColors: Record<string, string> = {
  running: '#22C55E',
  queued: '#FFE66D',
  done: '#4ECDC4',
  failed: '#EF4444',
  cancelled: '#9CA3AF',
};

export function StatusIndicator({ status }: StatusIndicatorProps) {
  const color = statusColors[status] || '#9CA3AF';
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className={cn(
          'w-2.5 h-2.5 border-2 border-nb-border inline-block',
          status === 'running' && 'animate-pulse'
        )}
        style={{ backgroundColor: color }}
      />
      <span className="font-mono text-xs font-bold uppercase text-nb-text">{status}</span>
    </span>
  );
}
