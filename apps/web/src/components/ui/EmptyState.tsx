interface EmptyStateProps {
  icon?: string;
  title: string;
  subtitle?: string;
  action?: { label: string; onClick: () => void };
}

export function EmptyState({ icon = '/', title, subtitle, action }: EmptyStateProps) {
  return (
    <div className="border-3 border-nb-border p-10 text-center bg-nb-surface">
      <span className="inline-block text-4xl mb-3 opacity-40">{icon}</span>
      <p className="font-display text-xl font-bold uppercase text-nb-text">{title}</p>
      {subtitle && <p className="font-mono text-sm text-nb-muted mt-2 uppercase">{subtitle}</p>}
      {action && (
        <button
          onClick={action.onClick}
          className="mt-4 px-4 py-2 border-2 border-nb-border font-mono text-xs font-bold uppercase bg-nb-surface hover:bg-nb-surface-hover text-nb-text cursor-pointer transition-colors"
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
