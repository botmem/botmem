import { cn } from '@botmem/shared';
import { type ButtonHTMLAttributes } from 'react';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
  color?: string;
}

const variantStyles = {
  primary: 'bg-nb-lime text-black',
  secondary: 'bg-nb-surface text-nb-text',
  danger: 'bg-nb-red text-white',
  ghost: 'bg-transparent border-transparent shadow-none hover:shadow-none',
};

const sizeStyles = {
  sm: 'px-3 py-1.5 text-xs',
  md: 'px-5 py-2.5 text-sm',
  lg: 'px-7 py-3.5 text-base',
};

export function Button({
  variant = 'primary',
  size = 'md',
  color,
  className,
  disabled,
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      className={cn(
        'font-display font-bold uppercase tracking-wider',
        'border-3 border-nb-border shadow-nb',
        'hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-nb-sm',
        'active:translate-x-[4px] active:translate-y-[4px] active:shadow-none',
        'transition-all duration-100 cursor-pointer',
        'disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:translate-x-0 disabled:hover:translate-y-0 disabled:hover:shadow-nb',
        variantStyles[variant],
        sizeStyles[size],
        className
      )}
      style={color ? { backgroundColor: color } : undefined}
      disabled={disabled}
      {...props}
    >
      {children}
    </button>
  );
}
