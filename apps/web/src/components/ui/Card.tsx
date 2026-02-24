import { cn } from '@botmem/shared';
import { type HTMLAttributes } from 'react';

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  hoverable?: boolean;
  color?: string;
}

export function Card({ hoverable, color, className, children, ...props }: CardProps) {
  return (
    <div
      className={cn(
        'border-3 border-nb-border bg-nb-surface shadow-nb p-4',
        hoverable && [
          'hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-nb-sm',
          'transition-all duration-100 cursor-pointer',
        ],
        className
      )}
      style={color ? { borderColor: color } : undefined}
      {...props}
    >
      {children}
    </div>
  );
}
