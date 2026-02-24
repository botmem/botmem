import { cn } from '@botmem/shared';
import type { ConnectorConfig } from '@botmem/shared';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';

const connectorIcons: Record<string, string> = {
  gmail: '✉',
  whatsapp: '💬',
  slack: '#',
  imessage: '◯',
  photos: '📷',
};

interface ConnectorCardProps {
  config: ConnectorConfig;
  connected: boolean;
  accountCount: number;
  onConnect: () => void;
  onSkip?: () => void;
  compact?: boolean;
}

export function ConnectorCard({ config, connected, accountCount, onConnect, onSkip, compact }: ConnectorCardProps) {
  return (
    <Card
      className={cn(
        'flex flex-col items-center gap-3 text-center',
        compact ? 'p-4' : 'p-6',
        connected && 'border-3'
      )}
      style={connected ? { borderColor: config.color } : undefined}
    >
      <div
        className="w-14 h-14 border-3 border-nb-border flex items-center justify-center text-2xl font-bold"
        style={{ backgroundColor: config.color }}
      >
        {connectorIcons[config.type]}
      </div>
      <h3 className="font-display text-lg font-bold uppercase text-nb-text">{config.label}</h3>
      {!compact && <p className="font-mono text-xs text-nb-muted">{config.description}</p>}

      {connected ? (
        <div className="flex flex-col gap-2 w-full">
          <div className="font-mono text-xs font-bold text-nb-green uppercase">
            ✓ {accountCount} CONNECTED
          </div>
          <Button size="sm" variant="secondary" onClick={onConnect}>
            ADD ANOTHER
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-2 w-full">
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
        </div>
      )}
    </Card>
  );
}
