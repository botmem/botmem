import { cn } from '@botmem/shared';
import { type SelectHTMLAttributes } from 'react';

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  options: Array<{ value: string; label: string }>;
}

export function Select({ label, options, className, ...props }: SelectProps) {
  return (
    <div className="flex flex-col gap-1.5">
      {label && (
        <label className="font-display text-xs font-bold uppercase tracking-wider text-nb-text">
          {label}
        </label>
      )}
      <div className="relative">
        <select
          className={cn(
            'border-3 border-nb-border px-4 py-3 pr-10 font-mono bg-nb-surface text-nb-text cursor-pointer w-full',
            'focus:outline-none focus:border-nb-lime focus:shadow-nb-sm appearance-none',
            className
          )}
          {...props}
        >
          {options.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        <span className="absolute right-3 top-1/2 -translate-y-1/2 font-bold text-nb-muted pointer-events-none">
          ▾
        </span>
      </div>
    </div>
  );
}
