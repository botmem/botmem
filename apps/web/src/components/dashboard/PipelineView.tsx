import type { QueueStats } from '../../store/jobStore';
import { AnimatedNumber } from '../ui/AnimatedNumber';

const PIPELINE_STAGES = ['sync', 'clean', 'embed', 'enrich'] as const;

const STAGE_META: Record<string, { color: string; icon: string; label: string }> = {
  sync: { color: 'var(--color-nb-blue)', icon: '\u2193', label: 'SYNC' },
  clean: { color: 'var(--color-nb-yellow)', icon: '\u2727', label: 'CLEAN' },
  embed: { color: 'var(--color-nb-lime)', icon: '\u25C8', label: 'EMBED' },
  enrich: { color: 'var(--color-nb-purple)', icon: '\u2726', label: 'ENRICH' },
};

const ROW_DEFS = [
  { key: 'active' as const, label: 'active', color: null },
  { key: 'waiting' as const, label: 'waiting', color: 'var(--color-nb-yellow)' },
  { key: 'delayed' as const, label: 'delayed', color: 'var(--color-nb-gray)' },
  { key: 'failed' as const, label: 'failed', color: 'var(--color-nb-red)' },
  { key: 'completed' as const, label: 'done', color: 'var(--color-nb-gray)' },
];

interface PipelineViewProps {
  queueStats: Record<string, QueueStats>;
}

export function PipelineView({ queueStats }: PipelineViewProps) {
  return (
    <div className="border-2 border-nb-border bg-nb-surface">
      <div className="bg-nb-black text-white px-4 py-2 font-display text-sm font-bold uppercase">
        PIPELINE
      </div>

      <div className="p-2 md:p-4 flex flex-wrap items-center gap-0 overflow-x-auto">
        {PIPELINE_STAGES.map((stage, i) => {
          const stats = queueStats[stage];
          const meta = STAGE_META[stage];
          if (!stats) return null;

          const isActive = stats.active > 0;
          const hasFailed = stats.failed > 0;

          return (
            <div
              key={stage}
              className="flex items-center min-w-[calc(50%-0.5rem)] sm:min-w-0 flex-1"
            >
              <div className="flex-1 min-w-0 overflow-hidden">
                <div
                  className="border-2 p-1.5 md:p-3 relative transition-colors"
                  style={{
                    borderColor: isActive
                      ? meta.color
                      : hasFailed
                        ? 'var(--color-nb-red)'
                        : 'var(--color-nb-surface-muted)',
                    backgroundColor: isActive ? meta.color + '10' : 'transparent',
                  }}
                >
                  {isActive && (
                    <div
                      className="absolute top-1.5 right-1.5 size-2 rounded-full animate-pulse"
                      style={{ backgroundColor: meta.color }}
                    />
                  )}

                  <div className="flex items-center gap-1.5 mb-2">
                    <span className="font-mono text-sm" style={{ color: meta.color }}>
                      {meta.icon}
                    </span>
                    <span
                      className="font-display text-[11px] md:text-xs font-bold uppercase tracking-wider"
                      style={{ color: isActive ? meta.color : 'var(--color-nb-muted)' }}
                    >
                      {meta.label}
                    </span>
                  </div>

                  <div className="flex flex-col gap-0.5">
                    {ROW_DEFS.map((row) => {
                      const value = stats[row.key];
                      const rowColor = row.color ?? meta.color;
                      return (
                        <div key={row.key} className="flex items-center gap-1.5 whitespace-nowrap">
                          <span
                            className="size-1.5 rounded-full shrink-0"
                            style={{ backgroundColor: rowColor, opacity: value > 0 ? 1 : 0.2 }}
                          />
                          <AnimatedNumber
                            value={value}
                            duration={400}
                            className="font-mono text-[11px] font-bold"
                            style={{
                              color: value > 0 ? rowColor : 'var(--color-nb-surface-muted)',
                            }}
                          />
                          <span
                            className="font-mono text-[11px]"
                            style={{
                              color:
                                value > 0
                                  ? 'var(--color-nb-muted)'
                                  : 'var(--color-nb-surface-muted)',
                            }}
                          >
                            {row.label}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>

              {i < PIPELINE_STAGES.length - 1 && (
                <div className="flex items-center px-2 shrink-0">
                  <svg width="20" height="20" viewBox="0 0 20 20" className="text-nb-border">
                    <path
                      d="M4 10 L14 10 M10 5 L15 10 L10 15"
                      fill="none"
                      stroke={isActive ? meta.color : 'currentColor'}
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
