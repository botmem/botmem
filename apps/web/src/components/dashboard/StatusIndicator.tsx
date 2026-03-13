import { cn, STATUS_COLORS } from '@botmem/shared';

interface StatusIndicatorProps {
  status: string;
}

export function StatusIndicator({ status }: StatusIndicatorProps) {
  const color = STATUS_COLORS[status] || 'var(--color-nb-gray)';
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className={cn(
          'w-2.5 h-2.5 border-2 border-nb-border inline-block',
          status === 'running' && 'animate-pulse',
        )}
        style={{ backgroundColor: color }}
      />
      <span className="font-mono text-xs font-bold uppercase text-nb-text">{status}</span>
    </span>
  );
}
