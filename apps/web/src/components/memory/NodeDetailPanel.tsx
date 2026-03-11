import { useState } from 'react';
import type { GraphNode } from '@botmem/shared';
import { CONNECTOR_COLORS, formatDate } from '@botmem/shared';
import { Card } from '../ui/Card';
import { Badge } from '../ui/Badge';
import { Avatar } from '../ui/Avatar';
import { ImageLightbox } from '../ui/ImageLightbox';
import { MemoryDetailCore } from './MemoryDetailCore';
import { IDENTIFIER_COLORS } from '../contacts/constants';
import type { ApiContact, ApiContactMemory } from '../../lib/api';

const SELF_COLOR = '#C4F53A';

interface NodeDetailPanelProps {
  selectedNode: GraphNode;
  selfNodeId: string | null;
  contactInfo: { detail: ApiContact | null; memories: ApiContactMemory[] } | null;
  connectionCounts: Map<string, number>;
  onClose: () => void;
  onRemoveIdentifier: (contactId: string, identId: string) => void;
}

export function NodeDetailPanel({
  selectedNode,
  selfNodeId,
  contactInfo,
  connectionCounts,
  onClose,
  onRemoveIdentifier,
}: NodeDetailPanelProps) {
  const isSelf = selfNodeId === selectedNode.id;
  const contactDetail = contactInfo?.detail ?? null;
  const contactMemories = contactInfo?.memories ?? [];
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);

  return (
    <div className="absolute top-2 right-2 w-72 z-10">
      <Card
        className="max-h-[400px] overflow-y-auto"
        style={
          isSelf ? { borderColor: SELF_COLOR, boxShadow: `0 0 12px ${SELF_COLOR}40` } : undefined
        }
      >
        <div className="flex items-center justify-between mb-2">
          <span
            className="font-display text-xs font-bold uppercase"
            style={isSelf ? { color: SELF_COLOR } : undefined}
          >
            {isSelf
              ? 'You'
              : selectedNode.nodeType === 'connector'
                ? 'Data Type'
                : selectedNode.nodeType === 'file'
                  ? 'File'
                  : selectedNode.nodeType === 'group'
                    ? 'Group'
                    : selectedNode.nodeType === 'device'
                      ? 'Device'
                      : selectedNode.nodeType === 'contact'
                        ? 'Person'
                        : 'Memory Detail'}
          </span>
          <button
            onClick={onClose}
            className="border-2 border-nb-border size-6 flex items-center justify-center text-xs font-bold cursor-pointer hover:bg-nb-red hover:text-white text-nb-text"
          >
            X
          </button>
        </div>

        {['contact', 'group', 'device'].includes(selectedNode.nodeType || '') ? (
          contactDetail ? (
            <div className="flex flex-col gap-3">
              <div className="font-mono text-sm font-bold text-nb-text">
                {contactDetail.displayName}
              </div>

              <Avatar
                contactId={contactDetail.id}
                fallbackInitials={contactDetail.displayName?.slice(0, 2).toUpperCase() || '?'}
                isSelf={isSelf}
                size="md"
              />

              <div className="flex gap-1 flex-wrap">
                {(selectedNode.connectors || []).map((c: string) => (
                  <span
                    key={c}
                    className="border-2 border-nb-border px-2 py-0.5 font-mono text-[10px] font-bold uppercase"
                    style={{ backgroundColor: CONNECTOR_COLORS[c] || '#999', color: '#000' }}
                  >
                    {c}
                  </span>
                ))}
              </div>

              {(contactDetail.identifiers?.length ?? 0) > 0 && (
                <div>
                  <span className="font-display text-[10px] font-bold uppercase tracking-wider text-nb-muted block mb-1">
                    Identifiers
                  </span>
                  <div className="flex flex-col gap-1">
                    {contactDetail.identifiers!.map((ident) => (
                      <div key={ident.id} className="flex items-center gap-2">
                        <Badge
                          color={
                            IDENTIFIER_COLORS[ident.identifierType ?? ''] ||
                            IDENTIFIER_COLORS[ident.type ?? '']
                          }
                          className="text-[10px] py-0 shrink-0"
                        >
                          {ident.identifierType || ident.type}
                        </Badge>
                        <span className="font-mono text-xs text-nb-text truncate flex-1">
                          {ident.identifierValue || ident.value}
                        </span>
                        <button
                          onClick={() =>
                            onRemoveIdentifier(selectedNode.id.replace(/^contact-/, ''), ident.id)
                          }
                          disabled={(contactDetail.identifiers?.length ?? 0) <= 1}
                          className="border border-nb-border size-5 flex items-center justify-center text-[10px] font-bold hover:bg-nb-red hover:text-white cursor-pointer text-nb-muted disabled:opacity-30 disabled:cursor-not-allowed shrink-0"
                        >
                          X
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="font-mono text-[10px] text-nb-muted">
                Connections:{' '}
                <span className="text-nb-text font-bold">
                  {connectionCounts.get(selectedNode.id) || 0}
                </span>
              </div>

              <div>
                <span className="font-display text-[10px] font-bold uppercase tracking-wider text-nb-muted block mb-1">
                  Linked Memories ({contactMemories.length})
                </span>
                <div className="flex flex-col gap-1 max-h-40 overflow-y-auto">
                  {contactMemories.length === 0 && (
                    <p className="font-mono text-[10px] text-nb-muted">No linked memories</p>
                  )}
                  {contactMemories.map((m) => (
                    <div key={m.id} className="border-2 border-nb-border p-1.5 bg-nb-surface-muted">
                      <div className="flex items-center gap-2 mb-0.5">
                        <span className="font-mono text-[10px] text-nb-muted">
                          {formatDate(m.eventTime || m.createdAt || '')}
                        </span>
                        <Badge className="text-[10px] py-0">{m.connectorType}</Badge>
                      </div>
                      <p className="font-mono text-[10px] text-nb-text line-clamp-2">{m.text}</p>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <div className="font-mono text-xs text-nb-muted">Loading...</div>
          )
        ) : (
          <MemoryDetailCore
            id={selectedNode.id}
            source={selectedNode.source}
            sourceConnector={selectedNode.sourceConnector}
            text={selectedNode.text || ''}
            eventTime={selectedNode.eventTime}
            weights={selectedNode.weights}
            entities={selectedNode.entities}
            metadata={selectedNode.metadata}
            importance={selectedNode.nodeType === 'memory' ? selectedNode.importance : undefined}
            connectionCount={connectionCounts.get(selectedNode.id) || 0}
            compact
            onThumbnailClick={setLightboxSrc}
          />
        )}
      </Card>
      {lightboxSrc && <ImageLightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />}
    </div>
  );
}
