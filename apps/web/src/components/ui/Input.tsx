import { cn } from '@botmem/shared';
import { type InputHTMLAttributes, forwardRef } from 'react';

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ label, className, id, name, ...props }, ref) => {
    const inputId = id || label?.toLowerCase().replace(/\s+/g, '-');
    const inputName = name || inputId;
    return (
      <div className="flex flex-col gap-1.5">
        {label && (
          <label
            htmlFor={inputId}
            className="font-display text-xs font-bold uppercase tracking-wider text-nb-text"
          >
            {label}
          </label>
        )}
        <input
          ref={ref}
          id={inputId}
          name={inputName}
          className={cn(
            'border-3 border-nb-border px-4 py-3 font-mono bg-nb-surface text-nb-text min-h-[44px]',
            'focus:outline-none focus:border-nb-lime focus:shadow-nb-sm',
            'placeholder:text-nb-muted placeholder:uppercase',
            className,
          )}
          {...props}
        />
      </div>
    );
  },
);
