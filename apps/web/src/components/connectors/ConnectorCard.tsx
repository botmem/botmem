import { cn } from '@botmem/shared';
import type { ConnectorConfig } from '@botmem/shared';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { getConnectorIcon } from '../../lib/connectorMeta';

interface ConnectorCardProps {
  config: ConnectorConfig;
  connected: boolean;
  accountCount: number;
  onConnect: () => void;
  onSkip?: () => void;
  compact?: boolean;
}

export function ConnectorCard({
  config,
  connected,
  accountCount,
  onConnect,
  onSkip,
  compact,
}: ConnectorCardProps) {
  return (
    <Card
      className={cn(
        'flex flex-col items-center gap-3 text-center h-full',
        compact ? 'p-4' : 'p-6',
        connected && 'border-3',
      )}
      style={connected ? { borderColor: config.color } : undefined}
    >
      <div
        className="size-14 border-3 border-nb-border flex items-center justify-center text-2xl font-bold shrink-0"
        style={{ backgroundColor: config.color }}
      >
        {getConnectorIcon(config.type)}
      </div>
      <h3 className="font-display text-sm font-bold uppercase text-nb-text line-clamp-1">
        {config.label}
      </h3>
      {!compact && (
        <p className="font-mono text-xs text-nb-muted line-clamp-2 min-h-[2lh]">
          {config.description}
        </p>
      )}

      <div className="flex flex-col gap-2 w-full mt-auto">
        {connected ? (
          <>
            <div className="font-mono text-xs font-bold text-nb-green uppercase">
              {'\u2713'} {accountCount} CONNECTED
            </div>
            <Button size="sm" variant="secondary" onClick={onConnect}>
              ADD ANOTHER
            </Button>
          </>
        ) : (
          <>
            <Button size="sm" color={config.color} onClick={onConnect}>
              CONNECT
            </Button>
            {onSkip && (
              <button
                onClick={onSkip}
                className="font-mono text-xs text-nb-muted hover:text-nb-text uppercase cursor-pointer"
              >
                SKIP
              </button>
            )}
          </>
        )}
      </div>
    </Card>
  );
}
