interface ActiveFilters {
  connectorTypes: string[];
  sourceTypes: string[];
  factualityLabels: string[];
  personNames: string[];
  timeRange: { from: string | null; to: string | null };
  pinned: boolean | null;
}

interface ActiveFiltersProps {
  activeFilters: ActiveFilters;
  onRemoveFilter: (key: string, value: string) => void;
  onClearAll: () => void;
}

interface FilterPill {
  key: string;
  value: string;
  label: string;
}

export function ActiveFiltersBar({
  activeFilters,
  onRemoveFilter,
  onClearAll,
}: ActiveFiltersProps) {
  const pills: FilterPill[] = [];

  for (const v of activeFilters.connectorTypes)
    pills.push({ key: 'connectorTypes', value: v, label: v });
  for (const v of activeFilters.sourceTypes) pills.push({ key: 'sourceTypes', value: v, label: v });
  for (const v of activeFilters.factualityLabels)
    pills.push({ key: 'factualityLabels', value: v, label: v });
  for (const v of activeFilters.personNames) pills.push({ key: 'personNames', value: v, label: v });
  if (activeFilters.timeRange.from)
    pills.push({
      key: 'timeRange',
      value: 'from',
      label: `From: ${activeFilters.timeRange.from.slice(0, 10)}`,
    });
  if (activeFilters.timeRange.to)
    pills.push({
      key: 'timeRange',
      value: 'to',
      label: `To: ${activeFilters.timeRange.to.slice(0, 10)}`,
    });
  if (activeFilters.pinned !== null) pills.push({ key: 'pinned', value: 'true', label: 'PINNED' });

  if (pills.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {pills.map((pill) => (
        <span
          key={`${pill.key}-${pill.value}`}
          className="flex items-center gap-1 border-2 border-nb-border bg-nb-surface px-2 py-1 font-mono text-xs"
        >
          <span className="uppercase text-nb-text">{pill.label}</span>
          <button
            type="button"
            onClick={() => onRemoveFilter(pill.key, pill.value)}
            className="cursor-pointer text-nb-muted hover:text-nb-red"
            aria-label={`Remove ${pill.label} filter`}
          >
            &times;
          </button>
        </span>
      ))}
      {pills.length > 1 && (
        <button
          type="button"
          onClick={onClearAll}
          className="cursor-pointer font-mono text-[11px] uppercase text-nb-muted hover:text-nb-lime"
        >
          CLEAR ALL
        </button>
      )}
    </div>
  );
}
