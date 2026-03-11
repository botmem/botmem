import type { QueueStats } from '../../store/jobStore';

const PIPELINE_STAGES = ['sync', 'clean', 'embed', 'enrich'] as const;

const STAGE_META: Record<string, { color: string; icon: string; label: string }> = {
  sync: { color: '#4ECDC4', icon: '\u2193', label: 'SYNC' },
  clean: { color: '#FFE66D', icon: '\u2727', label: 'CLEAN' },
  embed: { color: '#C4F53A', icon: '\u25C8', label: 'EMBED' },
  enrich: { color: '#A78BFA', icon: '\u2726', label: 'ENRICH' },
};

const ROW_DEFS = [
  { key: 'active' as const, label: 'active', color: null },
  { key: 'waiting' as const, label: 'waiting', color: '#FFE66D' },
  { key: 'delayed' as const, label: 'delayed', color: '#9CA3AF' },
  { key: 'failed' as const, label: 'failed', color: '#EF4444' },
  { key: 'completed' as const, label: 'done', color: '#6B7280' },
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

      <div className="p-2 md:p-4 flex items-center gap-0 overflow-x-auto">
        {PIPELINE_STAGES.map((stage, i) => {
          const stats = queueStats[stage];
          const meta = STAGE_META[stage];
          if (!stats) return null;

          const isActive = stats.active > 0;
          const hasFailed = stats.failed > 0;

          return (
            <div key={stage} className="flex items-center flex-1 min-w-[80px]">
              <div className="flex-1 min-w-0 overflow-hidden">
                <div
                  className="border-2 p-1.5 md:p-3 relative transition-colors"
                  style={{
                    borderColor: isActive ? meta.color : hasFailed ? '#EF4444' : '#3a3a3a',
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
                      className="font-display text-[10px] md:text-xs font-bold uppercase tracking-wider"
                      style={{ color: isActive ? meta.color : '#888' }}
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
                          <span
                            className="font-mono text-[11px] font-bold"
                            style={{ color: value > 0 ? rowColor : '#444' }}
                          >
                            {value.toLocaleString()}
                          </span>
                          <span
                            className="font-mono text-[10px]"
                            style={{ color: value > 0 ? '#9CA3AF' : '#444' }}
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
