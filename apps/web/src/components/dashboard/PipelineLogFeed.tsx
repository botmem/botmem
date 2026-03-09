import { useState, useMemo, useRef, useEffect } from 'react';
import type { LogEntry, PipelineStage } from '@botmem/shared';
import { formatTime, CONNECTOR_COLORS } from '@botmem/shared';
import { Badge } from '../ui/Badge';
import { Card } from '../ui/Card';

const STAGES: PipelineStage[] = ['sync', 'embed', 'enrich', 'backfill'];

const STAGE_COLORS: Record<string, string> = {
  sync: '#4ECDC4',
  embed: '#C4F53A',
  enrich: '#A78BFA',
  backfill: '#F59E0B',
};

const STAGE_ICONS: Record<string, string> = {
  sync: '↓',
  embed: '◈',
  enrich: '✦',
  backfill: '↻',
};

const LEVEL_COLORS: Record<string, string> = {
  info: '#4ECDC4',
  warn: '#FFE66D',
  error: '#EF4444',
  debug: '#6B7280',
};

interface PipelineLogFeedProps {
  logs: LogEntry[];
}

export function PipelineLogFeed({ logs }: PipelineLogFeedProps) {
  const [stageFilter, setStageFilter] = useState<Set<string>>(new Set(STAGES));
  const [levelFilter, setLevelFilter] = useState<Set<string>>(new Set(['info', 'warn', 'error']));
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Only show logs that have a pipeline stage
  const pipelineLogs = useMemo(() => logs.filter((l) => l.stage), [logs]);

  const filtered = useMemo(() => {
    return pipelineLogs.filter((log) => {
      if (!stageFilter.has(log.stage!)) return false;
      if (!levelFilter.has(log.level)) return false;
      return true;
    });
  }, [pipelineLogs, stageFilter, levelFilter]);

  // Counts per stage
  const stageCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const log of pipelineLogs) {
      counts[log.stage!] = (counts[log.stage!] || 0) + 1;
    }
    return counts;
  }, [pipelineLogs]);

  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = 0;
    }
  }, [filtered.length, autoScroll]);

  const toggleStage = (stage: string) => {
    setStageFilter((prev) => {
      const next = new Set(prev);
      if (next.has(stage)) next.delete(stage);
      else next.add(stage);
      return next;
    });
  };

  const toggleLevel = (level: string) => {
    setLevelFilter((prev) => {
      const next = new Set(prev);
      if (next.has(level)) next.delete(level);
      else next.add(level);
      return next;
    });
  };

  return (
    <Card className="p-0 overflow-hidden">
      <div className="bg-nb-black text-white px-4 py-2 font-display text-sm font-bold uppercase flex items-center justify-between">
        <span>PIPELINE ACTIVITY</span>
        <div className="flex items-center gap-3">
          <span className="font-mono text-[10px] text-nb-muted">
            {filtered.length}/{pipelineLogs.length} entries
          </span>
          <button
            onClick={() => setAutoScroll(!autoScroll)}
            className="font-mono text-[10px] px-1.5 py-0.5 border border-nb-border/50 cursor-pointer transition-colors"
            style={{
              backgroundColor: autoScroll ? '#4ECDC420' : 'transparent',
              color: autoScroll ? '#4ECDC4' : '#666',
            }}
          >
            AUTO
          </button>
        </div>
      </div>

      {/* Stage + Level filter bar */}
      <div className="px-3 py-2 border-b-2 border-nb-border bg-nb-surface flex flex-wrap items-center gap-1.5">
        {STAGES.map((stage) => (
          <button
            key={stage}
            onClick={() => toggleStage(stage)}
            className="font-mono text-[10px] font-bold uppercase px-2 py-0.5 border-2 cursor-pointer transition-colors flex items-center gap-1"
            style={{
              borderColor: STAGE_COLORS[stage],
              backgroundColor: stageFilter.has(stage) ? STAGE_COLORS[stage] : 'transparent',
              color: stageFilter.has(stage) ? '#000' : STAGE_COLORS[stage],
              opacity: stageFilter.has(stage) ? 1 : 0.5,
            }}
          >
            <span>{STAGE_ICONS[stage]}</span>
            {stage}
            {stageCounts[stage] ? <span className="ml-0.5 opacity-70">({stageCounts[stage]})</span> : null}
          </button>
        ))}

        <div className="w-px h-4 bg-nb-border mx-1" />

        {(['info', 'warn', 'error', 'debug'] as const).map((level) => (
          <button
            key={level}
            onClick={() => toggleLevel(level)}
            className="font-mono text-[10px] font-bold uppercase px-2 py-0.5 border-2 cursor-pointer transition-colors"
            style={{
              borderColor: LEVEL_COLORS[level],
              backgroundColor: levelFilter.has(level) ? LEVEL_COLORS[level] : 'transparent',
              color: levelFilter.has(level) ? '#000' : LEVEL_COLORS[level],
              opacity: levelFilter.has(level) ? 1 : 0.5,
            }}
          >
            {level}
          </button>
        ))}
      </div>

      {/* Log entries */}
      <div
        ref={scrollRef}
        className="max-h-[350px] overflow-y-auto bg-nb-surface-muted"
        onScroll={() => {
          if (scrollRef.current) {
            setAutoScroll(scrollRef.current.scrollTop < 10);
          }
        }}
      >
        <table className="w-full">
          <thead>
            <tr className="border-b-2 border-nb-border/40 sticky top-0 bg-nb-surface-muted z-10">
              <th className="text-left font-mono text-[10px] text-nb-muted uppercase px-3 py-1.5 w-16">Time</th>
              <th className="text-left font-mono text-[10px] text-nb-muted uppercase px-2 py-1.5 w-16">Stage</th>
              <th className="text-left font-mono text-[10px] text-nb-muted uppercase px-2 py-1.5 w-14">Level</th>
              <th className="text-left font-mono text-[10px] text-nb-muted uppercase px-2 py-1.5 w-16">Source</th>
              <th className="text-left font-mono text-[10px] text-nb-muted uppercase px-2 py-1.5">Details</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((log, idx) => (
              <PipelineLogRow key={`${log.id}-${idx}`} entry={log} />
            ))}
          </tbody>
        </table>
        {filtered.length === 0 && (
          <p className="font-mono text-sm text-nb-muted text-center py-8 uppercase">
            {pipelineLogs.length === 0 ? 'NO PIPELINE ACTIVITY YET' : 'NO MATCHES'}
          </p>
        )}
      </div>
    </Card>
  );
}

function PipelineLogRow({ entry }: { entry: LogEntry }) {
  const stageColor = STAGE_COLORS[entry.stage || ''] || '#666';

  return (
    <tr className="border-b border-nb-border/20 hover:bg-nb-border/10 transition-colors">
      <td className="font-mono text-[11px] text-nb-muted px-3 py-1.5 whitespace-nowrap">
        {formatTime(entry.timestamp)}
      </td>
      <td className="px-2 py-1.5">
        <span
          className="inline-flex items-center gap-1 font-mono text-[10px] font-bold uppercase px-1.5 py-0.5"
          style={{ color: stageColor, backgroundColor: stageColor + '15' }}
        >
          {STAGE_ICONS[entry.stage || '']} {entry.stage}
        </span>
      </td>
      <td className="px-2 py-1.5">
        <Badge color={LEVEL_COLORS[entry.level]} className="!text-[9px] !px-1.5 !py-0">
          {entry.level}
        </Badge>
      </td>
      <td className="px-2 py-1.5">
        <span
          className="font-mono text-[10px] font-bold uppercase"
          style={{ color: CONNECTOR_COLORS[entry.connector] || '#888' }}
        >
          {entry.connector}
        </span>
      </td>
      <td className="font-mono text-[11px] text-nb-text px-2 py-1.5">
        <span className="line-clamp-2">{entry.message}</span>
      </td>
    </tr>
  );
}
