import { describe, it, expect, beforeEach, vi } from 'vitest';

// Stub localStorage
const store: Record<string, string> = {};
vi.stubGlobal('localStorage', {
  getItem: (key: string) => store[key] ?? null,
  setItem: (key: string, value: string) => {
    store[key] = value;
  },
  removeItem: (key: string) => {
    delete store[key];
  },
  clear: () => {
    Object.keys(store).forEach((k) => delete store[k]);
  },
  get length() {
    return Object.keys(store).length;
  },
  key: (i: number) => Object.keys(store)[i] ?? null,
});

// Stub document.documentElement.setAttribute
const setAttrSpy = vi.fn();
vi.stubGlobal('document', {
  documentElement: {
    setAttribute: setAttrSpy,
  },
});

// Stub matchMedia
const matchMediaListeners: ((...args: unknown[]) => void)[] = [];
vi.stubGlobal(
  'matchMedia',
  vi.fn((query: string) => ({
    matches: query.includes('dark'),
    media: query,
    addEventListener: vi.fn((_event: string, fn: (...args: unknown[]) => void) => {
      matchMediaListeners.push(fn);
    }),
    removeEventListener: vi.fn(),
  })),
);

// Import store after stubs
const { useThemeStore } = await import('../themeStore');

describe('themeStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useThemeStore.setState({ theme: 'system', resolvedTheme: 'dark' });
  });

  it('initializes with system theme', () => {
    const state = useThemeStore.getState();
    expect(state.theme).toBe('system');
    expect(['dark', 'light']).toContain(state.resolvedTheme);
  });

  it('setTheme sets to dark', () => {
    useThemeStore.getState().setTheme('dark');
    const state = useThemeStore.getState();
    expect(state.theme).toBe('dark');
    expect(state.resolvedTheme).toBe('dark');
  });

  it('setTheme sets to light', () => {
    useThemeStore.getState().setTheme('light');
    const state = useThemeStore.getState();
    expect(state.theme).toBe('light');
    expect(state.resolvedTheme).toBe('light');
  });

  it('setTheme to system resolves to system preference', () => {
    useThemeStore.getState().setTheme('system');
    const state = useThemeStore.getState();
    expect(state.theme).toBe('system');
    expect(['dark', 'light']).toContain(state.resolvedTheme);
  });

  it('applies theme to document element', () => {
    useThemeStore.getState().setTheme('light');
    expect(setAttrSpy).toHaveBeenCalledWith('data-theme', 'light');
  });
});
