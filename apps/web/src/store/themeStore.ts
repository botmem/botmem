import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { trackEvent } from '../lib/posthog';

export type ThemePreference = 'dark' | 'light' | 'system';
export type ResolvedTheme = 'dark' | 'light';

interface ThemeStore {
  theme: ThemePreference;
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: ThemePreference) => void;
}

function getSystemTheme(): ResolvedTheme {
  if (typeof window === 'undefined') return 'dark';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(resolved: ResolvedTheme) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.classList.add('theme-switching');
  root.setAttribute('data-theme', resolved);
  setTimeout(() => root.classList.remove('theme-switching'), 200);
}

export const useThemeStore = create<ThemeStore>()(
  persist(
    (set, _get) => ({
      theme: 'system',
      resolvedTheme: getSystemTheme(),
      setTheme: (theme) => {
        const resolved = theme === 'system' ? getSystemTheme() : theme;
        applyTheme(resolved);
        trackEvent('theme_changed', { theme, resolved });
        set({ theme, resolvedTheme: resolved });
      },
    }),
    { name: 'botmem-theme' },
  ),
);

// Initialize on load — apply stored or system theme immediately
(function initTheme() {
  if (typeof document === 'undefined') return;
  const store = useThemeStore.getState();
  const resolved = store.theme === 'system' ? getSystemTheme() : store.theme;
  applyTheme(resolved);
  useThemeStore.setState({ resolvedTheme: resolved });
})();

// React to system preference changes when user has 'system' selected
if (typeof window !== 'undefined') {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    const store = useThemeStore.getState();
    if (store.theme === 'system') {
      const newResolved: ResolvedTheme = e.matches ? 'dark' : 'light';
      applyTheme(newResolved);
      useThemeStore.setState({ resolvedTheme: newResolved });
    }
  });
}
