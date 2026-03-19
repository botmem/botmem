import type { RefObject } from 'react';
import { cn } from '@/lib/utils';

interface SearchInputProps {
  value: string;
  onChange: (value: string) => void;
  pending?: boolean;
  placeholder?: string;
  className?: string;
  inputRef?: RefObject<HTMLInputElement | null>;
}

export function SearchInput({
  value,
  onChange,
  pending,
  placeholder = 'SEARCH...',
  className = '',
  inputRef,
}: SearchInputProps) {
  return (
    <div className={cn('relative', className)}>
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full border-3 px-3 py-1.5 pr-24 font-mono text-xs bg-nb-surface text-nb-text focus:outline-none focus:border-nb-lime placeholder:text-nb-muted placeholder:uppercase transition-all duration-300"
        style={{
          borderColor: pending ? 'var(--color-nb-lime)' : undefined,
          boxShadow: pending
            ? '0 0 8px color-mix(in srgb, var(--color-nb-lime) 25%, transparent)'
            : undefined,
        }}
      />
      {pending && (
        <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1.5">
          <div className="size-3 border-2 border-nb-lime border-t-transparent rounded-full animate-spin" />
          <span className="font-mono text-[11px] text-nb-lime uppercase">Searching...</span>
        </div>
      )}
    </div>
  );
}
