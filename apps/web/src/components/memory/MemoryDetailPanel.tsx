import type { Memory } from '@botmem/shared';
import { formatDate, formatTime, CONNECTOR_COLORS } from '@botmem/shared';
import { Card } from '../ui/Card';
import { Badge } from '../ui/Badge';
import { FactualityBadge } from './FactualityBadge';

interface MemoryDetailPanelProps {
  memory: Memory;
  onClose: () => void;
}

export function MemoryDetailPanel({ memory, onClose }: MemoryDetailPanelProps) {
  const weights = Object.entries(memory.weights);

  return (
    <Card className="sticky top-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-display text-lg font-bold uppercase text-nb-text">Memory Detail</h3>
        <button
          onClick={onClose}
          className="border-2 border-nb-border w-8 h-8 flex items-center justify-center font-bold hover:bg-nb-red hover:text-white cursor-pointer text-nb-text"
        >
          X
        </button>
      </div>

      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-2">
          <Badge color={CONNECTOR_COLORS[memory.sourceConnector]}>{memory.sourceConnector}</Badge>
          <Badge>{memory.source}</Badge>
          <FactualityBadge label={memory.factuality.label} />
        </div>

        <div className="border-3 border-nb-border p-3 bg-nb-surface-muted">
          <p className="font-mono text-sm text-nb-text">{memory.text}</p>
        </div>

        <div className="grid grid-cols-2 gap-2 text-xs font-mono">
          <div>
            <span className="text-nb-muted uppercase">Event:</span>{' '}
            <span className="text-nb-text">{formatDate(memory.time)} {formatTime(memory.time)}</span>
          </div>
          <div>
            <span className="text-nb-muted uppercase">Ingested:</span>{' '}
            <span className="text-nb-text">{formatDate(memory.ingestTime)}</span>
          </div>
        </div>

        <div>
          <h4 className="font-display text-xs font-bold uppercase mb-2 text-nb-text">Weight Breakdown</h4>
          <div className="flex flex-col gap-1.5">
            {weights.map(([key, val]) => (
              <div key={key} className="flex items-center gap-2">
                <span className="font-mono text-xs uppercase w-20 text-nb-muted">{key}</span>
                <div className="flex-1 h-4 border-2 border-nb-border bg-nb-surface-muted">
                  <div
                    className="h-full transition-all"
                    style={{
                      width: `${val * 100}%`,
                      backgroundColor: key === 'final' ? '#C4F53A' : '#A855F7',
                    }}
                  />
                </div>
                <span className="font-mono text-xs w-10 text-right text-nb-text">{(val * 100).toFixed(0)}%</span>
              </div>
            ))}
          </div>
        </div>

        {memory.entities.length > 0 && (
          <div>
            <h4 className="font-display text-xs font-bold uppercase mb-2 text-nb-text">Entities</h4>
            <div className="flex flex-wrap gap-1.5">
              {memory.entities.map((e, i) => (
                <Badge key={i} color="#4ECDC4">
                  {e.type}: {e.value}
                </Badge>
              ))}
            </div>
          </div>
        )}

        {memory.claims.length > 0 && (
          <div>
            <h4 className="font-display text-xs font-bold uppercase mb-2 text-nb-text">Claims</h4>
            <div className="flex flex-col gap-1">
              {memory.claims.map((c) => (
                <div key={c.id} className="border-2 border-nb-border p-2 bg-nb-surface-muted">
                  <Badge className="mb-1">{c.type}</Badge>
                  <p className="font-mono text-xs text-nb-text">{c.text}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        <div>
          <h4 className="font-display text-xs font-bold uppercase mb-2 text-nb-text">Factuality</h4>
          <div className="border-2 border-nb-border p-2 bg-nb-surface-muted">
            <p className="font-mono text-xs text-nb-text">
              <span className="font-bold">Confidence:</span> {(memory.factuality.confidence * 100).toFixed(0)}%
            </p>
            <p className="font-mono text-xs mt-1 text-nb-text">{memory.factuality.rationale}</p>
          </div>
        </div>
      </div>
    </Card>
  );
}
