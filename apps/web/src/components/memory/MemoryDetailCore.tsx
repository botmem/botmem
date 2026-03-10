import { CONNECTOR_COLORS, formatDate, formatTime } from '@botmem/shared';
import { Badge } from '../ui/Badge';
import { AuthedImage } from '../ui/AuthedImage';

function hasThumbnail(source: string, metadata?: Record<string, any>): boolean {
  return (source === 'file' || source === 'photo') && !!metadata?.fileUrl;
}

function ContextRow({ label, value, bold: isBold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div>
      <span className="text-nb-muted uppercase">{label}: </span>
      <span className={`text-nb-text ${isBold ? 'font-bold' : ''}`}>{value}</span>
    </div>
  );
}

function MemoryContext({ metadata }: { metadata: Record<string, any> }) {
  const rows: { label: string; value: string; bold?: boolean }[] = [];

  // WhatsApp / message sender + recipient
  if (metadata.senderName || metadata.senderPhone) {
    const name = metadata.senderName || metadata.senderPhone;
    const suffix = metadata.senderName && metadata.senderPhone ? ` (${metadata.senderPhone})` : '';
    const you = metadata.fromMe === true ? ' (you)' : '';
    rows.push({ label: 'From', value: `${name}${suffix}${you}`, bold: true });

    // Show recipient for DMs
    if (!metadata.isGroup && metadata.chatId) {
      const chatPhone = metadata.chatId.replace(/@.*$/, '');
      if (metadata.fromMe) {
        // Sent by you → recipient is the chat contact
        const recipientName = metadata.chatName || chatPhone;
        const recipientSuffix = metadata.chatName && chatPhone !== metadata.chatName ? ` (${chatPhone})` : '';
        rows.push({ label: 'To', value: `${recipientName}${recipientSuffix}` });
      } else {
        // Received → you are the recipient
        const selfPhone = metadata.selfPhone || '';
        rows.push({ label: 'To', value: selfPhone ? `You (${selfPhone})` : 'You' });
      }
    }
  }

  // Email from/to/subject
  if (metadata.from && !metadata.senderName) rows.push({ label: 'From', value: metadata.from, bold: true });
  if (metadata.to) rows.push({ label: 'To', value: metadata.to });
  if (metadata.subject) rows.push({ label: 'Subject', value: metadata.subject });

  // Slack channel
  if (metadata.channel) {
    const prefix = metadata.channelType === 'channel' ? '#' : '';
    rows.push({ label: 'Channel', value: `${prefix}${metadata.channel}` });
  }

  // Chat/group name
  if (metadata.chatName) rows.push({ label: metadata.isGroup ? 'Group' : 'Chat', value: metadata.chatName });

  // Photo metadata
  if (metadata.people?.length) {
    const names = metadata.people.map((p: any) => p.name || p).join(', ');
    rows.push({ label: 'People', value: names });
  }
  if (metadata.cameraMake || metadata.cameraModel) {
    rows.push({ label: 'Camera', value: [metadata.cameraMake, metadata.cameraModel].filter(Boolean).join(' ') });
  }
  if (metadata.city || metadata.country) {
    rows.push({ label: 'Location', value: [metadata.city, metadata.state, metadata.country].filter(Boolean).join(', ') });
  }

  // Location
  if (metadata.lat != null && metadata.lon != null && !metadata.senderName) {
    rows.push({ label: 'Coords', value: `${metadata.lat.toFixed(4)}, ${metadata.lon.toFixed(4)}` });
  }
  if (metadata.regions?.length) rows.push({ label: 'Region', value: metadata.regions.join(', ') });
  if (metadata.activity?.length) rows.push({ label: 'Activity', value: metadata.activity.join(', ') });

  // File
  if (metadata.fileName) rows.push({ label: 'File', value: metadata.fileName });

  if (!rows.length) return null;

  return (
    <div className="border-2 border-nb-border p-2 bg-nb-surface-muted font-mono text-xs flex flex-col gap-0.5">
      {rows.map((r, i) => <ContextRow key={i} label={r.label} value={r.value} bold={r.bold} />)}
    </div>
  );
}

interface MemoryDetailCoreProps {
  id: string;
  source: string;
  sourceConnector?: string;
  text: string;
  eventTime?: string;
  ingestTime?: string;
  weights?: Record<string, number>;
  entities?: Array<{ type: string; value: string }> | string[];
  claims?: Array<{ id: string; type: string; text: string }>;
  metadata?: Record<string, any>;
  importance?: number;
  connectionCount?: number;
  compact?: boolean;
  showTimestamps?: boolean;
  showClaims?: boolean;
  onThumbnailClick?: (src: string) => void;
}

export function MemoryDetailCore({
  id,
  source,
  sourceConnector,
  text,
  eventTime,
  ingestTime,
  weights,
  entities,
  claims,
  metadata,
  importance,
  connectionCount,
  compact,
  showTimestamps,
  showClaims,
  onThumbnailClick,
}: MemoryDetailCoreProps) {
  const filteredWeights = weights
    ? Object.entries(weights).filter(
        ([key, val]) => !(key === 'semantic' && val === 0) && !(key === 'rerank' && val === 0),
      )
    : [];

  const barH = compact ? 'h-3' : 'h-4';
  const barBorder = compact ? 'border' : 'border-2';

  return (
    <div className="flex flex-col gap-3">
      {/* Source badges */}
      <div className="flex gap-1 flex-wrap">
        <span
          className="border-2 border-nb-border px-2 py-0.5 font-mono text-[10px] font-bold uppercase"
          style={{
            backgroundColor: CONNECTOR_COLORS[sourceConnector || source] || '#999',
            color: '#000',
          }}
        >
          {sourceConnector || source}
        </span>
        {sourceConnector && sourceConnector !== source && (
          <span className="border-2 border-nb-border px-2 py-0.5 font-mono text-[10px] font-bold uppercase text-nb-text">
            {source}
          </span>
        )}
      </div>

      {/* Context metadata */}
      {metadata && <MemoryContext metadata={metadata} />}

      {/* Thumbnail */}
      {hasThumbnail(source, metadata) && (
        <div
          className={`border-3 border-nb-border overflow-hidden ${compact ? 'max-h-56' : 'max-h-80'} ${onThumbnailClick ? 'cursor-zoom-in' : ''}`}
          onClick={() => onThumbnailClick?.(`/api/memories/${id}/thumbnail`)}
        >
          <AuthedImage
            src={`/api/memories/${id}/thumbnail`}
            className="w-full object-cover"
            style={metadata?.width && metadata?.height
              ? { aspectRatio: `${metadata.width} / ${metadata.height}` }
              : { height: '14rem' }}
            loading="lazy"
          />
        </div>
      )}

      {/* Text */}
      {text && (
        <div className={`border-3 border-nb-border ${compact ? 'p-2 max-h-32 overflow-y-auto' : 'p-3'} bg-nb-surface-muted`}>
          <p className={`font-mono ${compact ? 'text-xs' : 'text-sm'} text-nb-text ${compact ? 'whitespace-pre-wrap break-words' : ''}`}>
            {text}
          </p>
        </div>
      )}

      {/* Timestamps */}
      {showTimestamps && (eventTime || ingestTime) && (
        <div className="grid grid-cols-2 gap-2 text-xs font-mono">
          {eventTime && (
            <div>
              <span className="text-nb-muted uppercase">Event:</span>{' '}
              <span className="text-nb-text">
                {formatDate(eventTime)} {formatTime(eventTime)}
              </span>
            </div>
          )}
          {ingestTime && (
            <div>
              <span className="text-nb-muted uppercase">Ingested:</span>{' '}
              <span className="text-nb-text">{formatDate(ingestTime)}</span>
            </div>
          )}
        </div>
      )}

      {/* Compact timestamps (graph panel style) */}
      {compact && eventTime && !showTimestamps && (
        <div className="font-mono text-[10px] text-nb-muted">
          EVENT: {new Date(eventTime).toLocaleDateString()}{' '}
          {new Date(eventTime).toLocaleTimeString()}
        </div>
      )}

      {/* Connection count + importance */}
      {(connectionCount != null || importance != null) && (
        <div className="flex gap-3 font-mono text-[10px]">
          {connectionCount != null && (
            <span className="text-nb-muted">
              Connections:{' '}
              <span className="text-nb-text font-bold">{connectionCount}</span>
            </span>
          )}
          {importance != null && (
            <span className="text-nb-muted">
              Importance:{' '}
              <span className="text-nb-text font-bold">
                {(importance * 100).toFixed(0)}%
              </span>
            </span>
          )}
        </div>
      )}

      {/* Weight breakdown */}
      {filteredWeights.length > 0 && (
        <div>
          <span className="font-display text-xs font-bold uppercase mb-1 block text-nb-text">
            Weight Breakdown
          </span>
          <div className="flex flex-col gap-1">
            {filteredWeights.map(([key, val]) => (
              <div key={key} className="flex items-center gap-1.5">
                <span className={`font-mono text-[10px] uppercase ${compact ? 'w-16' : 'w-20'} text-nb-muted`}>
                  {key}
                </span>
                <div className={`flex-1 ${barH} ${barBorder} border-nb-border bg-nb-surface-muted`}>
                  <div
                    className="h-full transition-all"
                    style={{
                      width: `${(typeof val === 'number' ? val : 0) * 100}%`,
                      backgroundColor: key === 'final' ? '#C4F53A' : '#A855F7',
                    }}
                  />
                </div>
                <span className="font-mono text-[10px] w-8 text-right text-nb-text">
                  {(typeof val === 'number' ? val * 100 : 0).toFixed(0)}%
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Entities */}
      {entities && entities.length > 0 && (
        <div>
          <span className="font-display text-xs font-bold uppercase mb-1 block text-nb-text">
            Entities
          </span>
          <div className="flex flex-wrap gap-1">
            {entities.map((e) => {
              if (typeof e === 'string') {
                return (
                  <span
                    key={e}
                    className="border border-nb-border px-1.5 py-0.5 font-mono text-[10px] bg-nb-surface text-nb-text"
                  >
                    {e}
                  </span>
                );
              }
              return (
                <Badge key={`${e.type}:${e.value}`} color="#4ECDC4">
                  {e.type}: {e.value}
                </Badge>
              );
            })}
          </div>
        </div>
      )}

      {/* Claims */}
      {showClaims && claims && claims.length > 0 && (
        <div>
          <span className="font-display text-xs font-bold uppercase mb-1 block text-nb-text">
            Claims
          </span>
          <div className="flex flex-col gap-1">
            {claims.map((c) => (
              <div key={c.id} className="border-2 border-nb-border p-2 bg-nb-surface-muted">
                <Badge className="mb-1">{c.type}</Badge>
                <p className="font-mono text-xs text-nb-text">{c.text}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
