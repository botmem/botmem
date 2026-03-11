import { cn } from '@botmem/shared';

interface SkeletonProps {
  className?: string;
  variant?: 'line' | 'card' | 'avatar';
  count?: number;
}

function SkeletonBlock({ className }: { className?: string }) {
  return (
    <div
      className={cn('border-3 border-nb-border bg-nb-surface-muted', className)}
      style={{ animation: 'pulse-bar 1.5s ease-in-out infinite' }}
    />
  );
}

export function Skeleton({ className, variant = 'line', count = 1 }: SkeletonProps) {
  const items = Array.from({ length: count });

  if (variant === 'card') {
    return (
      <div className={cn('flex flex-col gap-3', className)}>
        {items.map((_, i) => (
          <div key={i} className="border-3 border-nb-border bg-nb-surface shadow-nb p-4">
            <SkeletonBlock className="h-4 w-2/3 mb-3" />
            <SkeletonBlock className="h-3 w-full mb-2" />
            <SkeletonBlock className="h-3 w-4/5" />
          </div>
        ))}
      </div>
    );
  }

  if (variant === 'avatar') {
    return (
      <div className={cn('flex items-center gap-3', className)}>
        <SkeletonBlock className="size-10 shrink-0" />
        <div className="flex-1">
          <SkeletonBlock className="h-3 w-1/3 mb-2" />
          <SkeletonBlock className="h-2.5 w-1/2" />
        </div>
      </div>
    );
  }

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      {items.map((_, i) => (
        <SkeletonBlock key={i} className="h-3 w-full" />
      ))}
    </div>
  );
}
