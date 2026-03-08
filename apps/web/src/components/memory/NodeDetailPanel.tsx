import type { GraphNode } from '@botmem/shared';
import { CONNECTOR_COLORS, formatDate } from '@botmem/shared';
import { Card } from '../ui/Card';
import { Badge } from '../ui/Badge';
import { IDENTIFIER_COLORS } from '../contacts/constants';

const SELF_COLOR = '#C4F53A';

interface NodeDetailPanelProps {
  selectedNode: GraphNode;
  selfNodeId: string | null;
  contactInfo: { detail: any; memories: any[] } | null;
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

  return (
    <div className="absolute top-2 right-2 w-72 z-10">
      <Card className="max-h-[400px] overflow-y-auto" style={isSelf ? { borderColor: SELF_COLOR, boxShadow: `0 0 12px ${SELF_COLOR}40` } : undefined}>
        <div className="flex items-center justify-between mb-2">
          <span className="font-display text-xs font-bold uppercase" style={isSelf ? { color: SELF_COLOR } : undefined}>
            {isSelf ? 'You' : selectedNode.nodeType === 'connector' ? 'Data Type' : selectedNode.nodeType === 'file' ? 'File' : selectedNode.nodeType === 'group' ? 'Group' : selectedNode.nodeType === 'device' ? 'Device' : selectedNode.nodeType === 'contact' ? 'Person' : 'Memory Detail'}
          </span>
          <button
            onClick={onClose}
            className="border-2 border-nb-border w-6 h-6 flex items-center justify-center text-xs font-bold cursor-pointer hover:bg-nb-red hover:text-white text-nb-text"
          >
            X
          </button>
        </div>

        {['contact', 'group', 'device'].includes(selectedNode.nodeType || '') ? (
          contactDetail ? (
            <div className="flex flex-col gap-3">
              <div className="font-mono text-sm font-bold text-nb-text">{contactDetail.displayName}</div>

              {contactDetail.avatars && JSON.parse(contactDetail.avatars || '[]').length > 0 && (
                <div className="flex gap-2 flex-wrap">
                  {JSON.parse(contactDetail.avatars).map((av: any) => (
                    <img key={av.url} src={av.url} alt="" className="border-2 border-nb-border w-12 h-12 object-cover" />
                  ))}
                </div>
              )}

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

              {contactDetail.identifiers?.length > 0 && (
                <div>
                  <span className="font-display text-[10px] font-bold uppercase tracking-wider text-nb-muted block mb-1">Identifiers</span>
                  <div className="flex flex-col gap-1">
                    {contactDetail.identifiers.map((ident: any) => (
                      <div key={ident.id} className="flex items-center gap-2">
                        <Badge color={IDENTIFIER_COLORS[ident.identifierType] || IDENTIFIER_COLORS[ident.type]} className="text-[10px] py-0 shrink-0">
                          {ident.identifierType || ident.type}
                        </Badge>
                        <span className="font-mono text-xs text-nb-text truncate flex-1">{ident.identifierValue || ident.value}</span>
                        <button
                          onClick={() => onRemoveIdentifier(selectedNode.id.replace(/^contact-/, ''), ident.id)}
                          disabled={contactDetail.identifiers.length <= 1}
                          className="border border-nb-border w-5 h-5 flex items-center justify-center text-[10px] font-bold hover:bg-nb-red hover:text-white cursor-pointer text-nb-muted disabled:opacity-30 disabled:cursor-not-allowed shrink-0"
                        >
                          X
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="font-mono text-[10px] text-nb-muted">
                Connections: <span className="text-nb-text font-bold">{connectionCounts.get(selectedNode.id) || 0}</span>
              </div>

              <div>
                <span className="font-display text-[10px] font-bold uppercase tracking-wider text-nb-muted block mb-1">
                  Linked Memories ({contactMemories.length})
                </span>
                <div className="flex flex-col gap-1 max-h-40 overflow-y-auto">
                  {contactMemories.length === 0 && (
                    <p className="font-mono text-[10px] text-nb-muted">No linked memories</p>
                  )}
                  {contactMemories.map((m: any) => (
                    <div key={m.id} className="border-2 border-nb-border p-1.5 bg-nb-surface-muted">
                      <div className="flex items-center gap-2 mb-0.5">
                        <span className="font-mono text-[10px] text-nb-muted">{formatDate(m.eventTime || m.createdAt)}</span>
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
          <>
            <div className="flex gap-1 flex-wrap mb-2">
              {selectedNode.nodeType === 'connector' ? (
                <span
                  className="border-2 border-nb-border px-2 py-0.5 font-mono text-[10px] font-bold uppercase"
                  style={{ backgroundColor: CONNECTOR_COLORS[selectedNode.source] || '#999', color: '#000' }}
                >
                  {selectedNode.source}
                </span>
              ) : (
                <>
                  <span
                    className="border-2 border-nb-border px-2 py-0.5 font-mono text-[10px] font-bold uppercase"
                    style={{ backgroundColor: CONNECTOR_COLORS[selectedNode.sourceConnector] || CONNECTOR_COLORS[selectedNode.source] || '#999', color: '#000' }}
                  >
                    {selectedNode.sourceConnector || selectedNode.source}
                  </span>
                  <span className="border-2 border-nb-border px-2 py-0.5 font-mono text-[10px] font-bold uppercase text-nb-text">
                    {selectedNode.source}
                  </span>
                </>
              )}
            </div>

            {selectedNode.nodeType === 'memory' && (selectedNode.source === 'file' || selectedNode.source === 'photo') && !!selectedNode.metadata?.fileUrl && (
              <div className="border-3 border-nb-border overflow-hidden mb-2">
                <img
                  src={`/api/memories/${selectedNode.id}/thumbnail`}
                  alt=""
                  className="w-full h-auto max-h-48 object-contain bg-black"
                  loading="lazy"
                />
              </div>
            )}

            {selectedNode.text && (
              <div className="border-3 border-nb-border p-2 bg-nb-surface-muted mb-2 max-h-32 overflow-y-auto">
                <p className="font-mono text-xs text-nb-text whitespace-pre-wrap break-words">{selectedNode.text}</p>
              </div>
            )}

            {selectedNode.eventTime && (
              <div className="font-mono text-[10px] text-nb-muted mb-2">
                EVENT: {new Date(selectedNode.eventTime).toLocaleDateString()} {new Date(selectedNode.eventTime).toLocaleTimeString()}
              </div>
            )}

            <div className="flex gap-3 mb-2 font-mono text-[10px]">
              <span className="text-nb-muted">Connections: <span className="text-nb-text font-bold">{connectionCounts.get(selectedNode.id) || 0}</span></span>
              {selectedNode.nodeType === 'memory' && (
                <span className="text-nb-muted">Importance: <span className="text-nb-text font-bold">{(selectedNode.importance * 100).toFixed(0)}%</span></span>
              )}
            </div>

            {selectedNode.nodeType === 'memory' && selectedNode.weights && (
              <div className="mb-2">
                <span className="font-display text-[10px] font-bold uppercase tracking-wider text-nb-muted block mb-1">Weight Breakdown</span>
                <div className="flex flex-col gap-1">
                  {Object.entries(selectedNode.weights).map(([key, val]) => (
                    <div key={key} className="flex items-center gap-1.5">
                      <span className="font-mono text-[10px] uppercase w-16 text-nb-muted">{key}</span>
                      <div className="flex-1 h-3 border border-nb-border bg-nb-surface-muted">
                        <div
                          className="h-full"
                          style={{
                            width: `${(typeof val === 'number' ? val : 0) * 100}%`,
                            backgroundColor: key === 'final' ? '#C4F53A' : '#A855F7',
                          }}
                        />
                      </div>
                      <span className="font-mono text-[10px] w-8 text-right text-nb-text">{(typeof val === 'number' ? val * 100 : 0).toFixed(0)}%</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {selectedNode.entities && selectedNode.entities.length > 0 && (
              <div>
                <span className="font-display text-[10px] font-bold uppercase tracking-wider text-nb-muted block mb-1">Entities</span>
                <div className="flex gap-1 flex-wrap">
                  {selectedNode.entities.map((e: string) => (
                    <span
                      key={e}
                      className="border border-nb-border px-1.5 py-0.5 font-mono text-[10px] bg-nb-surface text-nb-text"
                    >
                      {e}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </Card>
    </div>
  );
}
