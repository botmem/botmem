import { cn } from '@/lib/utils';

const SCORE_KEYS = ['semantic', 'recency', 'importance', 'trust', 'final'] as const;

export function getMemoryFinalScore(weights?: Record<string, number> | null) {
  return weights?.final || 0;
}

export function formatMemoryScore(score: number) {
  return `${(Math.min(score, 1) * 100).toFixed(0)}%`;
}

export function MemoryScoreBadge({ weights }: { weights?: Record<string, number> | null }) {
  const score = getMemoryFinalScore(weights);
  return (
    <span
      className="font-bold text-[11px] px-1 border border-nb-border"
      style={{ color: score > 0.7 ? 'var(--color-nb-lime)' : 'var(--color-nb-muted)' }}
    >
      {formatMemoryScore(score)}
    </span>
  );
}

export function MemoryScoreBreakdown({
  weights,
  compact,
}: {
  weights?: Record<string, number> | null;
  compact?: boolean;
}) {
  if (!weights || SCORE_KEYS.every((key) => weights[key] == null)) return null;

  const barH = compact ? 'h-3' : 'h-4';
  const barBorder = compact ? 'border' : 'border-2';

  return (
    <div>
      <span className="font-display text-xs font-bold uppercase mb-1 block text-nb-text">
        Weight Breakdown
      </span>
      <div className="flex flex-col gap-1">
        {SCORE_KEYS.map((key) => {
          const val = typeof weights[key] === 'number' ? weights[key] : 0;
          return (
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
                    width: `${Math.max(0, Math.min(val, 1)) * 100}%`,
                    backgroundColor:
                      key === 'final' ? 'var(--color-nb-lime)' : 'var(--color-nb-purple)',
                  }}
                />
              </div>
              <span className="font-mono text-[11px] w-8 text-right text-nb-text">
                {formatMemoryScore(val)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
