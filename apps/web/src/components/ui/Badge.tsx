import { cn } from '@botmem/shared';

interface BadgeProps {
  children: React.ReactNode;
  color?: string;
  className?: string;
}

export function Badge({ children, color, className }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-block border-2 border-nb-border px-2.5 py-0.5 font-mono text-xs font-bold uppercase',
        !color && 'bg-nb-surface-muted',
        className,
      )}
      style={color ? { backgroundColor: color, color: 'var(--color-nb-black)' } : undefined}
    >
      {children}
    </span>
  );
}
