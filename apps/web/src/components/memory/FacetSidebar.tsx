import { CONNECTOR_COLORS } from '@botmem/shared';
import type { ApiFacetCounts } from '../../lib/api';
import { FacetGroup } from './FacetGroup';
import { FacetCheckbox } from './FacetCheckbox';
import { TimeRangeFacet } from './TimeRangeFacet';

interface ActiveFilters {
  connectorTypes: string[];
  sourceTypes: string[];
  factualityLabels: string[];
  personNames: string[];
  timeRange: { from: string | null; to: string | null };
  pinned: boolean | null;
}

interface FacetSidebarProps {
  facets: ApiFacetCounts;
  activeFilters: ActiveFilters;
  onToggleFilter: (
    key: 'connectorTypes' | 'sourceTypes' | 'factualityLabels' | 'personNames',
    value: string,
  ) => void;
  onSetTimeRange: (from: string | null, to: string | null) => void;
  onClearAll: () => void;
}

const FACTUALITY_COLORS: Record<string, string> = {
  FACT: 'var(--color-nb-green)',
  UNVERIFIED: 'var(--color-nb-yellow)',
  FICTION: 'var(--color-nb-red)',
};

export function FacetSidebar({
  facets,
  activeFilters,
  onToggleFilter,
  onSetTimeRange,
  onClearAll,
}: FacetSidebarProps) {
  const hasAnyFilter =
    activeFilters.connectorTypes.length > 0 ||
    activeFilters.sourceTypes.length > 0 ||
    activeFilters.factualityLabels.length > 0 ||
    activeFilters.personNames.length > 0 ||
    activeFilters.timeRange.from !== null ||
    activeFilters.timeRange.to !== null ||
    activeFilters.pinned !== null;

  return (
    <div className="flex h-full w-60 flex-col border-r-2 border-nb-border bg-nb-surface">
      <div className="flex items-center justify-between border-b-2 border-nb-border px-3 py-2.5">
        <span className="font-display text-xs font-bold uppercase tracking-wider text-nb-text">
          FILTERS
        </span>
        {hasAnyFilter && (
          <button
            type="button"
            onClick={onClearAll}
            className="cursor-pointer font-mono text-[11px] uppercase text-nb-muted hover:text-nb-lime"
          >
            CLEAR ALL
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        <FacetGroup title="Connector Type">
          {facets.connectorType.map((f) => (
            <FacetCheckbox
              key={f.value}
              label={f.value}
              count={f.count}
              checked={activeFilters.connectorTypes.includes(f.value)}
              onChange={() => onToggleFilter('connectorTypes', f.value)}
              disabled={f.count === 0}
              color={CONNECTOR_COLORS[f.value]}
            />
          ))}
        </FacetGroup>

        <FacetGroup title="Source Type">
          {facets.sourceType.map((f) => (
            <FacetCheckbox
              key={f.value}
              label={f.value}
              count={f.count}
              checked={activeFilters.sourceTypes.includes(f.value)}
              onChange={() => onToggleFilter('sourceTypes', f.value)}
              disabled={f.count === 0}
            />
          ))}
        </FacetGroup>

        <FacetGroup title="Factuality">
          {facets.factualityLabel.map((f) => (
            <FacetCheckbox
              key={f.value}
              label={f.value}
              count={f.count}
              checked={activeFilters.factualityLabels.includes(f.value)}
              onChange={() => onToggleFilter('factualityLabels', f.value)}
              disabled={f.count === 0}
              color={FACTUALITY_COLORS[f.value]}
            />
          ))}
        </FacetGroup>

        <FacetGroup title="People" defaultOpen={false}>
          {facets.people.map((f) => (
            <FacetCheckbox
              key={f.value}
              label={f.value}
              count={f.count}
              checked={activeFilters.personNames.includes(f.value)}
              onChange={() => onToggleFilter('personNames', f.value)}
              disabled={f.count === 0}
            />
          ))}
        </FacetGroup>

        <FacetGroup title="Time Range">
          <TimeRangeFacet
            from={activeFilters.timeRange.from}
            to={activeFilters.timeRange.to}
            onChange={onSetTimeRange}
          />
        </FacetGroup>
      </div>
    </div>
  );
}
