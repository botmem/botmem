interface FacetCheckboxProps {
  label: string;
  count: number;
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
  color?: string;
}

export function FacetCheckbox({
  label,
  count,
  checked,
  onChange,
  disabled,
  color,
}: FacetCheckboxProps) {
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onChange}
      disabled={disabled}
      className={`flex w-full items-center gap-2 px-2 py-1.5 text-left transition-colors ${
        disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer hover:bg-nb-surface-hover'
      }`}
    >
      <span
        className={`flex h-4 w-4 shrink-0 items-center justify-center border-2 border-nb-border transition-colors`}
        style={
          checked
            ? {
                backgroundColor: color || 'var(--color-nb-lime)',
                borderColor: color || 'var(--color-nb-lime)',
              }
            : undefined
        }
      >
        {checked && (
          <svg
            width="10"
            height="8"
            viewBox="0 0 10 8"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            <path d="M1 4L3.5 6.5L9 1" stroke="#0D0D0D" strokeWidth="2" strokeLinecap="square" />
          </svg>
        )}
      </span>
      <span className="flex-1 truncate font-mono text-sm text-nb-text">{label}</span>
      <span className="font-mono text-xs text-nb-muted">{count}</span>
    </button>
  );
}
