import { cn } from '@botmem/shared';

interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: string;
}

export function Toggle({ checked, onChange, label }: ToggleProps) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className="flex items-center gap-2 cursor-pointer"
    >
      <div
        className={cn(
          'w-12 h-7 border-3 border-nb-border relative transition-colors duration-100',
          checked ? 'bg-nb-lime' : 'bg-nb-surface-muted',
        )}
      >
        <div
          className={cn(
            'size-5 border-2 border-nb-border bg-nb-text absolute top-0.5 transition-all duration-100',
            checked ? 'left-5' : 'left-0.5',
          )}
        />
      </div>
      {label && <span className="font-mono text-sm font-bold uppercase text-nb-text">{label}</span>}
    </button>
  );
}
