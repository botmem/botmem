import { cn } from '@botmem/shared';

interface ProgressBarProps {
  value: number;
  max?: number;
  color?: string;
  segments?: number;
  className?: string;
}

export function ProgressBar({ value, max = 100, color, segments, className }: ProgressBarProps) {
  const pct = Math.min((value / max) * 100, 100);

  if (segments) {
    const filled = Math.round((value / max) * segments);
    return (
      <div className={cn('flex gap-1', className)}>
        {Array.from({ length: segments }).map((_, i) => (
          <div
            key={i}
            className={cn(
              'h-4 flex-1 border-2 border-nb-border',
              i < filled ? 'bg-nb-lime' : 'bg-nb-surface-muted'
            )}
            style={i < filled && color ? { backgroundColor: color } : undefined}
          />
        ))}
      </div>
    );
  }

  return (
    <div className={cn('h-5 border-3 border-nb-border bg-nb-surface-muted', className)}>
      <div
        className="h-full bg-nb-lime transition-all duration-300"
        style={{ width: `${pct}%`, backgroundColor: color }}
      />
    </div>
  );
}
