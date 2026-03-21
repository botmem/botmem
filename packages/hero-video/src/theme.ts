import { createContext, useContext } from 'react';

// ─── Color palettes ──────────────────────────────────────────────────────────

export const lightColors = {
  bg: '#F5F3EF',
  surface: '#FFFFFF',
  surfaceHover: '#EDEAE4',
  surfaceMuted: '#E5E2DC',
  border: '#D4D0C8',
  borderStrong: '#B0ADA6',
  text: '#1A1A1A',
  muted: '#6B6B6B',
  black: '#000000',
  white: '#FFFFFF',
  lime: '#5A7A10',
  pink: '#D4366C',
  teal: '#0E8C83',
  purple: '#7C3AED',
  orange: '#FF8A50',
  red: '#EF4444',
  green: '#15803D',
  yellow: '#FFE66D',
} as const;

export const darkColors = {
  bg: '#0D0D0D',
  surface: '#1A1A1A',
  surfaceHover: '#262626',
  surfaceMuted: '#222222',
  border: '#333333',
  borderStrong: '#555555',
  text: '#E0E0E0',
  muted: '#999999',
  black: '#000000',
  white: '#FFFFFF',
  lime: '#C4F53A',
  pink: '#FF6B9D',
  teal: '#4ECDC4',
  purple: '#C084FC',
  orange: '#FF8A50',
  red: '#EF4444',
  green: '#22C55E',
  yellow: '#FFE66D',
} as const;

export type Colors = typeof lightColors;

// ─── Shadows ─────────────────────────────────────────────────────────────────

export const lightShadows = {
  sm: '2px 2px 0 rgba(0,0,0,0.10)',
  md: '4px 4px 0 rgba(0,0,0,0.10)',
  lg: '6px 6px 0 rgba(0,0,0,0.10)',
} as const;

export const darkShadows = {
  sm: '2px 2px 0 rgba(255,255,255,0.06)',
  md: '4px 4px 0 rgba(255,255,255,0.06)',
  lg: '6px 6px 0 rgba(255,255,255,0.06)',
} as const;

export type Shadows = typeof lightShadows;

// ─── Backward-compatible exports (default to light) ──────────────────────────

export const colors = lightColors;
export const shadows = lightShadows;

// ─── Theme context ───────────────────────────────────────────────────────────

export type ThemeMode = 'light' | 'dark';

export interface Theme {
  mode: ThemeMode;
  colors: Colors;
  shadows: Shadows;
}

export function getTheme(mode: ThemeMode): Theme {
  return {
    mode,
    colors: mode === 'dark' ? darkColors : lightColors,
    shadows: mode === 'dark' ? darkShadows : lightShadows,
  };
}

export const ThemeContext = createContext<Theme>(getTheme('light'));

export function useTheme(): Theme {
  return useContext(ThemeContext);
}

export const ThemeProvider = ThemeContext.Provider;

// ─── Spring presets ──────────────────────────────────────────────────────────

export const SPRING_SMOOTH = { damping: 200 };
export const SPRING_SNAPPY = { damping: 20, stiffness: 200 };
