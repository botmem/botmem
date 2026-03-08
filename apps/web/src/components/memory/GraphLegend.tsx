import { CONNECTOR_COLORS } from '@botmem/shared';
import type { FilterState, FilterAction } from './graphReducers';

const CONTACT_COLOR = '#60A5FA';
const GROUP_COLOR = '#C084FC';
const FILE_COLOR = '#FB923C';
const DEVICE_COLOR = '#2DD4BF';

function edgeTypeColor(type: string): string {
  if (type === 'contradicts') return '#EF4444';
  if (type === 'supports') return '#22C55E';
  if (type === 'involves') return 'rgba(96, 165, 250, 0.6)';
  if (type === 'attachment') return 'rgba(251, 146, 60, 0.6)';
  if (type === 'source') return 'rgba(163, 230, 53, 0.25)';
  return '#666';
}

function LegendToggle({ active, onClick, icon, label }: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1.5 px-2 py-1 border-2 font-mono text-[11px] uppercase cursor-pointer transition-all"
      style={{
        borderColor: active ? '#E0E0E0' : '#444',
        opacity: active ? 1 : 0.35,
        backgroundColor: active ? 'rgba(255,255,255,0.05)' : 'transparent',
        color: active ? '#F0F0F0' : '#888',
      }}
    >
      {icon}
      {label}
    </button>
  );
}

const SOURCE_TYPE_LABELS: Record<string, string> = {
  email: 'Email',
  message: 'Messages',
  location: 'Locations',
  file: 'Files',
  photo: 'Photos',
};

const EDGE_TYPE_LABELS: Record<string, string> = {
  involves: 'Mentions',
  source: 'From',
  contradicts: 'Conflicts with',
  supports: 'Supports',
  related: 'Related',
  attachment: 'Attachment',
};

interface GraphLegendProps {
  filters: FilterState;
  dispatch: React.Dispatch<FilterAction>;
  sourceTypes: string[];
  edgeTypes: string[];
  legendOpen: boolean;
  onToggleLegend: () => void;
  graphRef: React.RefObject<any>;
}

export function GraphLegend({
  filters,
  dispatch,
  sourceTypes,
  edgeTypes,
  legendOpen,
  onToggleLegend,
  graphRef,
}: GraphLegendProps) {
  return (
    <div className="absolute bottom-2 left-2 flex items-end gap-1 z-10">
      <div className="relative">
        <button
          onClick={onToggleLegend}
          className="border-2 border-nb-border h-8 px-3 flex items-center gap-2 font-mono text-xs font-bold uppercase bg-nb-surface text-nb-text hover:bg-nb-lime hover:text-black cursor-pointer transition-colors"
        >
          Legend
          <span className="text-[10px]">{legendOpen ? '\u2212' : '+'}</span>
        </button>

        {legendOpen && (
          <div className="absolute bottom-full left-0 mb-1 w-72 border-3 border-nb-border bg-nb-surface shadow-nb p-3 space-y-3">
            <div>
              <div className="font-display text-[10px] font-bold uppercase tracking-wider text-nb-muted mb-1.5">
                Nodes
              </div>
              <div className="flex flex-wrap gap-1.5">
                <LegendToggle
                  active={!filters.hideContacts}
                  onClick={() => dispatch({ type: 'toggleContacts' })}
                  icon={
                    <svg width="16" height="16" viewBox="0 0 16 16">
                      <circle cx="8" cy="8" r="7" fill={CONTACT_COLOR} stroke="#E0E0E0" strokeWidth="1" />
                      <circle cx="8" cy="6" r="2.5" fill="#1A1A2E" />
                      <ellipse cx="8" cy="13" rx="4" ry="3" fill="#1A1A2E" />
                    </svg>
                  }
                  label="People"
                />
                <LegendToggle
                  active={!filters.hideGroups}
                  onClick={() => dispatch({ type: 'toggleGroups' })}
                  icon={
                    <svg width="16" height="16" viewBox="0 0 16 16">
                      <polygon points="8,1 14.5,4.5 14.5,11.5 8,15 1.5,11.5 1.5,4.5" fill={GROUP_COLOR} stroke="#E0E0E0" strokeWidth="1" />
                      <circle cx="5.5" cy="6.5" r="1.5" fill="#1A1A2E" />
                      <circle cx="10.5" cy="6.5" r="1.5" fill="#1A1A2E" />
                      <ellipse cx="8" cy="11.5" rx="4" ry="2.5" fill="#1A1A2E" />
                    </svg>
                  }
                  label="Groups"
                />
                <LegendToggle
                  active={!filters.hideFiles}
                  onClick={() => dispatch({ type: 'toggleFiles' })}
                  icon={
                    <svg width="16" height="16" viewBox="0 0 16 16">
                      <polygon points="8,1 15,8 8,15 1,8" fill={FILE_COLOR} stroke="#E0E0E0" strokeWidth="1" />
                      <line x1="5" y1="7" x2="11" y2="7" stroke="#1A1A2E" strokeWidth="1.5" />
                      <line x1="5" y1="9.5" x2="11" y2="9.5" stroke="#1A1A2E" strokeWidth="1.5" />
                    </svg>
                  }
                  label="Files"
                />
                <LegendToggle
                  active={!filters.hideDevices}
                  onClick={() => dispatch({ type: 'toggleDevices' })}
                  icon={
                    <svg width="16" height="16" viewBox="0 0 16 16">
                      <rect x="2" y="2" width="12" height="12" rx="3" fill={DEVICE_COLOR} stroke="#E0E0E0" strokeWidth="1" />
                      <rect x="6" y="4" width="4" height="7" rx="0.5" fill="#1A1A2E" />
                      <circle cx="8" cy="12" r="0.8" fill="#1A1A2E" />
                    </svg>
                  }
                  label="Devices"
                />
                {sourceTypes.map((st) => (
                  <LegendToggle
                    key={st}
                    active={!filters.hiddenSourceTypes.has(st)}
                    onClick={() => dispatch({ type: 'toggleSourceType', source: st })}
                    icon={
                      <svg width="14" height="14" viewBox="0 0 14 14">
                        <rect x="1" y="1" width="12" height="12" fill={CONNECTOR_COLORS[st] || '#999'} stroke="#E0E0E0" strokeWidth="1" />
                      </svg>
                    }
                    label={SOURCE_TYPE_LABELS[st] || st}
                  />
                ))}
              </div>
            </div>

            <div>
              <div className="font-display text-[10px] font-bold uppercase tracking-wider text-nb-muted mb-1.5">
                Relationships
              </div>
              <div className="flex flex-wrap gap-1.5">
                {edgeTypes.map((type) => (
                  <LegendToggle
                    key={type}
                    active={!filters.hiddenEdgeTypes.has(type)}
                    onClick={() => dispatch({ type: 'toggleEdgeType', edgeType: type })}
                    icon={
                      <span className="w-4 flex items-center">
                        <span
                          className="w-full inline-block"
                          style={{
                            height: type === 'involves' ? 1 : 2,
                            backgroundColor: edgeTypeColor(type),
                            borderTop: type === 'involves' ? `1px dashed ${edgeTypeColor(type)}` : 'none',
                          }}
                        />
                      </span>
                    }
                    label={EDGE_TYPE_LABELS[type] || type}
                  />
                ))}
              </div>
            </div>

            <div>
              <div className="font-display text-[10px] font-bold uppercase tracking-wider text-nb-muted mb-1.5">
                Size = Importance
              </div>
              <div className="flex items-center gap-2 font-mono text-[10px] text-nb-muted">
                <span className="w-2 h-2 border border-nb-muted inline-block" /> low
                <span className="w-3 h-3 border border-nb-muted inline-block" /> med
                <span className="w-4 h-4 border border-nb-muted inline-block" /> high
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="flex gap-1">
        <button
          onClick={() => graphRef.current?.zoom(graphRef.current.zoom() * 1.5, 300)}
          className="border-2 border-nb-border w-8 h-8 flex items-center justify-center font-mono text-sm font-bold bg-nb-surface text-nb-text hover:bg-nb-lime hover:text-black cursor-pointer transition-colors"
        >+</button>
        <button
          onClick={() => graphRef.current?.zoom(graphRef.current.zoom() / 1.5, 300)}
          className="border-2 border-nb-border w-8 h-8 flex items-center justify-center font-mono text-sm font-bold bg-nb-surface text-nb-text hover:bg-nb-lime hover:text-black cursor-pointer transition-colors"
        >{'\u2212'}</button>
        <button
          onClick={() => graphRef.current?.zoomToFit(400)}
          className="border-2 border-nb-border w-8 h-8 flex items-center justify-center font-mono text-sm font-bold bg-nb-surface text-nb-text hover:bg-nb-lime hover:text-black cursor-pointer transition-colors"
        >{'\u2299'}</button>
      </div>
    </div>
  );
}
