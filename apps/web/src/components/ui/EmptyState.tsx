interface EmptyStateProps {
  icon?: string;
  title: string;
  subtitle?: string;
}

export function EmptyState({ icon = '/', title, subtitle }: EmptyStateProps) {
  return (
    <div className="border-3 border-nb-border p-10 text-center bg-nb-surface">
      <span className="inline-block text-4xl mb-3 opacity-40">{icon}</span>
      <p className="font-display text-xl font-bold uppercase text-nb-text">{title}</p>
      {subtitle && (
        <p className="font-mono text-sm text-nb-muted mt-2 uppercase">{subtitle}</p>
      )}
    </div>
  );
}
