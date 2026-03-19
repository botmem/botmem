interface TimeRangeFacetProps {
  from: string | null;
  to: string | null;
  onChange: (from: string | null, to: string | null) => void;
}

export function TimeRangeFacet({ from, to, onChange }: TimeRangeFacetProps) {
  const hasValue = from || to;

  return (
    <div className="flex flex-col gap-2 px-3 pb-2">
      <div className="flex flex-col gap-1">
        <label htmlFor="time-range-from" className="font-mono text-[11px] uppercase text-nb-muted">
          FROM
        </label>
        <input
          id="time-range-from"
          name="time-range-from"
          type="date"
          value={from ? from.slice(0, 10) : ''}
          onChange={(e) =>
            onChange(e.target.value ? new Date(e.target.value).toISOString() : null, to)
          }
          className="w-full border-2 border-nb-border bg-nb-bg p-1.5 font-mono text-xs text-nb-text focus:border-nb-lime focus:outline-none"
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="time-range-to" className="font-mono text-[11px] uppercase text-nb-muted">
          TO
        </label>
        <input
          id="time-range-to"
          name="time-range-to"
          type="date"
          value={to ? to.slice(0, 10) : ''}
          onChange={(e) =>
            onChange(from, e.target.value ? new Date(e.target.value).toISOString() : null)
          }
          className="w-full border-2 border-nb-border bg-nb-bg p-1.5 font-mono text-xs text-nb-text focus:border-nb-lime focus:outline-none"
        />
      </div>
      {hasValue && (
        <button
          type="button"
          onClick={() => onChange(null, null)}
          className="cursor-pointer font-mono text-[11px] uppercase text-nb-muted hover:text-nb-lime"
        >
          CLEAR DATES
        </button>
      )}
    </div>
  );
}
