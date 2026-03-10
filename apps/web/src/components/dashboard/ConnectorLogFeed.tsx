import { useState, useMemo, useRef, useEffect } from 'react';
import type { LogEntry, PipelineStage } from '@botmem/shared';
import { CONNECTOR_COLORS } from '@botmem/shared';
import { LogEntryRow } from './LogEntry';
import { Card } from '../ui/Card';

const LEVELS = ['info', 'warn', 'error', 'debug'] as const;
const LEVEL_COLORS: Record<string, string> = {
  info: '#4ECDC4',
  warn: '#FFE66D',
  error: '#EF4444',
  debug: '#9CA3AF',
};

const STAGES: PipelineStage[] = ['sync', 'embed', 'enrich', 'backfill'];
const STAGE_COLORS: Record<string, string> = {
  sync: '#4ECDC4',
  embed: '#C4F53A',
  enrich: '#A78BFA',
  backfill: '#F59E0B',
};
const STAGE_ICONS: Record<string, string> = {
  sync: '\u2193',
  embed: '\u25C8',
  enrich: '\u2726',
  backfill: '\u21BB',
};

interface ConnectorLogFeedProps {
  logs: LogEntry[];
  onClear?: () => void;
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
}

export function ConnectorLogFeed({ logs, onClear, hasMore, loadingMore, onLoadMore }: ConnectorLogFeedProps) {
  const [levelFilter, setLevelFilter] = useState<Set<string>>(new Set(LEVELS));
  const [connectorFilter, setConnectorFilter] = useState<Set<string>>(new Set());
  const [stageFilter, setStageFilter] = useState<Set<string>>(new Set([...STAGES, '__none__']));
  const [searchText, setSearchText] = useState('');
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Derive unique connectors from actual log data
  const connectors = useMemo(() => {
    const set = new Set<string>();
    for (const log of logs) if (log.connector) set.add(log.connector);
    return Array.from(set).sort();
  }, [logs]);

  // Stage counts
  const stageCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const log of logs) {
      const key = log.stage || '__none__';
      counts[key] = (counts[key] || 0) + 1;
    }
    return counts;
  }, [logs]);

  // Default: show all connectors when filter set is empty
  const filtered = useMemo(() => {
    return logs.filter((log) => {
      if (!levelFilter.has(log.level)) return false;
      if (connectorFilter.size > 0 && !connectorFilter.has(log.connector)) return false;
      const logStage = log.stage || '__none__';
      if (!stageFilter.has(logStage)) return false;
      if (searchText && !log.message.toLowerCase().includes(searchText.toLowerCase())) return false;
      return true;
    });
  }, [logs, levelFilter, connectorFilter, stageFilter, searchText]);

  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = 0;
    }
  }, [filtered.length, autoScroll]);

  const toggleLevel = (level: string) => {
    setLevelFilter((prev) => {
      const next = new Set(prev);
      if (next.has(level)) next.delete(level);
      else next.add(level);
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

  const toggleStage = (stage: string) => {
    setStageFilter((prev) => {
      const next = new Set(prev);
      if (next.has(stage)) next.delete(stage);
      else next.add(stage);
      return next;
    });
  };

  return (
    <Card className="p-0 overflow-hidden flex flex-col" style={{ minHeight: 460 }}>
      <div className="bg-nb-black text-white px-4 py-2 font-display text-sm font-bold uppercase flex items-center justify-between">
        <span>LIVE LOG FEED</span>
        <div className="flex items-center gap-3">
          <span className="font-mono text-xs text-nb-muted">{filtered.length}/{logs.length}</span>
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
          {onClear && (
            <button
              onClick={onClear}
              className="font-mono text-[10px] px-1.5 py-0.5 border border-nb-red/50 text-nb-red cursor-pointer hover:bg-nb-red/20 transition-colors"
            >
              CLEAR
            </button>
          )}
        </div>
      </div>

      {/* Filters */}
      <div className="px-3 py-2 border-b-2 border-nb-border bg-nb-surface flex flex-wrap items-center gap-1.5">
        {/* Stage toggles */}
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

        {/* Separator */}
        <div className="w-px h-4 bg-nb-border mx-1" />

        {/* Level toggles */}
        {LEVELS.map((level) => (
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

        {/* Separator */}
        {connectors.length > 0 && (
          <div className="w-px h-4 bg-nb-border mx-1" />
        )}

        {/* Connector toggles */}
        {connectors.map((conn) => (
          <button
            key={conn}
            onClick={() => toggleConnector(conn)}
            className="font-mono text-[10px] font-bold uppercase px-2 py-0.5 border-2 cursor-pointer transition-colors"
            style={{
              borderColor: CONNECTOR_COLORS[conn] || '#666',
              backgroundColor: connectorFilter.size === 0 || connectorFilter.has(conn)
                ? (CONNECTOR_COLORS[conn] || '#666')
                : 'transparent',
              color: connectorFilter.size === 0 || connectorFilter.has(conn) ? '#000' : (CONNECTOR_COLORS[conn] || '#666'),
              opacity: connectorFilter.size === 0 || connectorFilter.has(conn) ? 1 : 0.5,
            }}
          >
            {conn}
          </button>
        ))}

        {/* Search */}
        <input
          type="text"
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          placeholder="filter..."
          className="ml-auto font-mono text-[10px] bg-transparent border-b border-nb-border text-nb-text placeholder:text-nb-muted/50 outline-none w-20 focus:w-32 transition-all"
        />
      </div>

      <div
        ref={scrollRef}
        className="p-3 overflow-y-auto bg-nb-surface-muted flex-1"
        style={{ maxHeight: 'calc(100vh - 20rem)' }}
        onScroll={() => {
          if (scrollRef.current) {
            const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
            setAutoScroll(scrollTop < 10);
            // Load more when scrolled near bottom
            if (scrollHeight - scrollTop - clientHeight < 200 && hasMore && !loadingMore && onLoadMore) {
              onLoadMore();
            }
          }
        }}
      >
        {filtered.map((log, idx) => (
          <LogEntryRow key={`${log.id}-${idx}`} entry={log} />
        ))}
        {(hasMore || loadingMore) && (
          <div className="py-3 text-center">
            <span className="font-mono text-xs text-nb-muted uppercase">Loading more...</span>
          </div>
        )}
        {filtered.length === 0 && (
          <div className="py-8 text-center">
            <span className="inline-block text-2xl mb-2 opacity-30">{'>'}_</span>
            <p className="font-display text-sm font-bold uppercase text-nb-muted">
              {logs.length === 0 ? 'NO LOG ENTRIES YET' : 'NO MATCHES'}
            </p>
          </div>
        )}
      </div>
    </Card>
  );
}
