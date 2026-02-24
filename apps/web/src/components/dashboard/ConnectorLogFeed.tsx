import { useState, useMemo } from 'react';
import type { LogEntry } from '@botmem/shared';
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

interface ConnectorLogFeedProps {
  logs: LogEntry[];
}

export function ConnectorLogFeed({ logs }: ConnectorLogFeedProps) {
  const [levelFilter, setLevelFilter] = useState<Set<string>>(new Set(LEVELS));
  const [connectorFilter, setConnectorFilter] = useState<Set<string>>(new Set());
  const [searchText, setSearchText] = useState('');

  // Derive unique connectors from actual log data
  const connectors = useMemo(() => {
    const set = new Set<string>();
    for (const log of logs) if (log.connector) set.add(log.connector);
    return Array.from(set).sort();
  }, [logs]);

  // Default: show all connectors when filter set is empty
  const filtered = useMemo(() => {
    return logs.filter((log) => {
      if (!levelFilter.has(log.level)) return false;
      if (connectorFilter.size > 0 && !connectorFilter.has(log.connector)) return false;
      if (searchText && !log.message.toLowerCase().includes(searchText.toLowerCase())) return false;
      return true;
    });
  }, [logs, levelFilter, connectorFilter, searchText]);

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

  return (
    <Card className="p-0 overflow-hidden">
      <div className="bg-nb-black text-white px-4 py-2 font-display text-sm font-bold uppercase flex items-center justify-between">
        <span>LIVE LOG FEED</span>
        <span className="font-mono text-xs text-nb-muted">{filtered.length}/{logs.length}</span>
      </div>

      {/* Filters */}
      <div className="px-3 py-2 border-b-2 border-nb-border bg-nb-surface flex flex-wrap items-center gap-1.5">
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

      <div className="p-3 max-h-[400px] overflow-y-auto bg-nb-surface-muted">
        {filtered.map((log) => (
          <LogEntryRow key={log.id} entry={log} />
        ))}
        {filtered.length === 0 && (
          <p className="font-mono text-sm text-nb-muted text-center py-8 uppercase">
            {logs.length === 0 ? 'NO LOG ENTRIES YET' : 'NO MATCHES'}
          </p>
        )}
      </div>
    </Card>
  );
}
