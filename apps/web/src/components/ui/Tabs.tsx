import { cn } from '@botmem/shared';

interface TabsProps {
  tabs: Array<{ id: string; label: string }>;
  active: string;
  onChange: (id: string) => void;
}

export function Tabs({ tabs, active, onChange }: TabsProps) {
  return (
    <div className="flex border-3 border-nb-border bg-nb-surface">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          onClick={() => onChange(tab.id)}
          className={cn(
            'px-5 py-2.5 font-display text-sm font-bold uppercase tracking-wider cursor-pointer',
            'border-r-3 border-nb-border last:border-r-0 transition-colors',
            active === tab.id
              ? 'bg-nb-text text-nb-bg'
              : 'bg-nb-surface text-nb-text hover:bg-nb-surface-hover'
          )}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
