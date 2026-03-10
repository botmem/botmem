import type { RefObject } from 'react';

interface SearchInputProps {
  value: string;
  onChange: (value: string) => void;
  pending?: boolean;
  placeholder?: string;
  className?: string;
  inputRef?: RefObject<HTMLInputElement | null>;
}

export function SearchInput({ value, onChange, pending, placeholder = 'SEARCH...', className = '', inputRef }: SearchInputProps) {
  return (
    <div className={`relative ${className}`}>
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full border-3 px-3 py-1.5 pr-24 font-mono text-xs bg-nb-surface text-nb-text focus:outline-none focus:border-nb-lime placeholder:text-nb-muted placeholder:uppercase transition-all duration-300"
        style={{
          borderColor: pending ? '#C4F53A' : undefined,
          boxShadow: pending ? '0 0 8px #C4F53A40' : undefined,
        }}
      />
      {pending && (
        <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1.5">
          <div className="w-3 h-3 border-2 border-nb-lime border-t-transparent rounded-full animate-spin" />
          <span className="font-mono text-[10px] text-nb-lime uppercase">Searching...</span>
        </div>
      )}
    </div>
  );
}
