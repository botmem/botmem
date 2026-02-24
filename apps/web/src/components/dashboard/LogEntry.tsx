import type { LogEntry as LogEntryType } from '@botmem/shared';
import { formatTime, CONNECTOR_COLORS } from '@botmem/shared';
import { Badge } from '../ui/Badge';

const levelColors: Record<string, string> = {
  info: '#4ECDC4',
  warn: '#FFE66D',
  error: '#EF4444',
  debug: '#9CA3AF',
};

export function LogEntryRow({ entry }: { entry: LogEntryType }) {
  return (
    <div className="flex items-start gap-2 py-1.5 border-b border-nb-border/30 last:border-0">
      <span className="font-mono text-xs text-nb-muted shrink-0 w-18">
        {formatTime(entry.timestamp)}
      </span>
      <Badge color={levelColors[entry.level]} className="shrink-0">
        {entry.level}
      </Badge>
      <span
        className="font-mono text-xs font-bold uppercase shrink-0"
        style={{ color: CONNECTOR_COLORS[entry.connector] }}
      >
        {entry.connector}
      </span>
      <span className="font-mono text-xs text-nb-text">{entry.message}</span>
    </div>
  );
}
