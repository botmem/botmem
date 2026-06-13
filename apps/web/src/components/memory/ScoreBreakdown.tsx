import { cn } from '@/lib/utils';

interface ScoreBreakdownProps {
  weights?: Record<string, number>;
  compact?: boolean;
}

const SCORE_KEYS = ['semantic', 'recency', 'importance', 'trust', 'final'];

export function ScoreBreakdown({ weights, compact }: ScoreBreakdownProps) {
  if (!weights) return null;

  const rows = SCORE_KEYS.map((key) => [key, weights[key] ?? 0] as const).filter(
    ([key, value]) => key !== 'final' || value > 0,
  );
  if (!rows.length) return null;

  const barH = compact ? 'h-3' : 'h-4';
  const barBorder = compact ? 'border' : 'border-2';

  return (
    <div>
      <span className="font-display text-xs font-bold uppercase mb-1 block text-nb-text">
        Weight Breakdown
      </span>
      <div className="flex flex-col gap-1">
        {rows.map(([key, val]) => (
          <div key={key} className="flex items-center gap-1.5">
            <span
              className={cn(
                'font-mono text-[11px] uppercase text-nb-muted',
                compact ? 'w-16' : 'w-20',
              )}
            >
              {key}
            </span>
            <div className={`flex-1 ${barH} ${barBorder} border-nb-border bg-nb-surface-muted`}>
              <div
                className="h-full transition-all"
                style={{
                  width: `${Math.max(0, Math.min(1, val)) * 100}%`,
                  backgroundColor:
                    key === 'final' ? 'var(--color-nb-lime)' : 'var(--color-nb-purple)',
                }}
              />
            </div>
            <span className="font-mono text-[11px] w-8 text-right text-nb-text">
              {(val * 100).toFixed(0)}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
