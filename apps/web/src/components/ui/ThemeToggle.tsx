import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { useThemeStore, type ThemePreference } from '../../store/themeStore';

interface ThemeToggleProps {
  /** 'icon' shows just sun/moon (default), 'full' shows label too */
  variant?: 'icon' | 'full';
  className?: string;
}

/**
 * Cycles through dark → light → system (auto) → dark.
 * Shows sun, moon, or auto (half-circle) icon depending on current state.
 */
export function ThemeToggle({ variant = 'icon', className = '' }: ThemeToggleProps) {
  const { theme, setTheme } = useThemeStore();

  const cycle: Record<ThemePreference, ThemePreference> = {
    dark: 'light',
    light: 'system',
    system: 'dark',
  };

  const labels: Record<ThemePreference, string> = {
    dark: 'DARK',
    light: 'LIGHT',
    system: 'AUTO',
  };

  const icons: Record<ThemePreference, ReactNode> = {
    dark: (
      // Moon icon
      <svg
        width="14"
        height="14"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M13.5 10A6 6 0 0 1 6 2.5a6 6 0 1 0 7.5 7.5z" />
      </svg>
    ),
    light: (
      // Sun icon
      <svg
        width="14"
        height="14"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="8" cy="8" r="3" />
        <path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.05 3.05l1.41 1.41M11.54 11.54l1.41 1.41M3.05 12.95l1.41-1.41M11.54 4.46l1.41-1.41" />
      </svg>
    ),
    system: (
      // Half-circle "auto" icon
      <svg
        width="14"
        height="14"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="8" cy="8" r="6" />
        <path d="M8 2v12" />
        <path d="M8 2a6 6 0 0 1 0 12z" fill="currentColor" stroke="none" />
      </svg>
    ),
  };

  if (variant === 'full') {
    return (
      <button
        onClick={() => setTheme(cycle[theme])}
        className={cn(
          'flex items-center gap-2 border-2 border-nb-border px-3 py-1.5 font-display text-xs font-bold uppercase text-nb-text hover:bg-nb-lime hover:text-black transition-colors cursor-pointer',
          className,
        )}
        aria-label={`Theme: ${labels[theme]}. Click to switch.`}
        title={`Theme: ${labels[theme]}`}
      >
        {icons[theme]}
        <span>{labels[theme]}</span>
      </button>
    );
  }

  return (
    <button
      onClick={() => setTheme(cycle[theme])}
      className={cn(
        'border-2 border-nb-border size-8 flex items-center justify-center text-nb-text hover:bg-nb-lime hover:text-black transition-colors cursor-pointer',
        className,
      )}
      aria-label={`Theme: ${labels[theme]}. Click to switch.`}
      title={`Switch theme (${labels[theme]})`}
    >
      {icons[theme]}
    </button>
  );
}
