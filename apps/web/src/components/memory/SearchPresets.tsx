interface SearchPresetsProps {
  activePreset: string | null;
  onPresetClick: (id: string) => void;
}

const PRESETS = [
  { id: 'recent_emails', label: 'RECENT EMAILS' },
  { id: 'recent_photos', label: 'RECENT PHOTOS' },
  { id: 'pinned', label: 'PINNED' },
  { id: 'facts_only', label: 'FACTS ONLY' },
  { id: 'this_week', label: 'THIS WEEK' },
];

export function SearchPresets({ activePreset, onPresetClick }: SearchPresetsProps) {
  return (
    <div className="flex gap-2 overflow-x-auto py-1">
      {PRESETS.map((p) => (
        <button
          key={p.id}
          type="button"
          onClick={() => onPresetClick(p.id)}
          className={`shrink-0 cursor-pointer border-2 px-3 py-1 font-mono text-[11px] uppercase tracking-wider transition-colors ${
            activePreset === p.id
              ? 'border-nb-lime bg-nb-lime/20 text-nb-lime'
              : 'border-nb-border text-nb-muted hover:border-nb-lime/50 hover:text-nb-text'
          }`}
        >
          {p.label}
        </button>
      ))}
    </div>
  );
}
