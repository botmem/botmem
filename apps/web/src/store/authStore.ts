import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { User } from '@botmem/shared';

interface AuthState {
  user: User | null;
  accessToken: string | null;
  isLoading: boolean;
  error: string | null;
  login: (email: string, password: string) => Promise<void>;
  signup: (email: string, password: string, name: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshSession: () => Promise<boolean>;
  initialize: () => Promise<void>;
  completeOnboarding: () => void;
  clearError: () => void;
}

const API_BASE = '/api/user-auth';

async function authFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...options?.headers },
    credentials: 'include',
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ message: `Error ${res.status}` }));
    throw new Error(body.message || `Error ${res.status}`);
  }
  return res.json();
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      accessToken: null,
      isLoading: true,
      error: null,

      login: async (email: string, password: string) => {
        set({ error: null, isLoading: true });
        try {
          const data = await authFetch<{ accessToken: string; user: User }>('/login', {
            method: 'POST',
            body: JSON.stringify({ email, password }),
          });
          set({ user: data.user, accessToken: data.accessToken, isLoading: false });
        } catch (err: any) {
          set({ error: err.message, isLoading: false });
          throw err;
        }
      },

      signup: async (email: string, password: string, name: string) => {
        set({ error: null, isLoading: true });
        try {
          const data = await authFetch<{ accessToken: string; user: User }>('/register', {
            method: 'POST',
            body: JSON.stringify({ email, password, name }),
          });
          set({ user: data.user, accessToken: data.accessToken, isLoading: false });
        } catch (err: any) {
          set({ error: err.message, isLoading: false });
          throw err;
        }
      },

      logout: async () => {
        try {
          await authFetch('/logout', { method: 'POST' });
        } catch {
          // Logout should always clear state even if API call fails
        }
        set({ user: null, accessToken: null, error: null });
      },

      refreshSession: async (): Promise<boolean> => {
        try {
          const data = await authFetch<{ accessToken: string }>('/refresh', {
            method: 'POST',
          });
          // Fetch user profile with the new access token
          const meRes = await fetch(`${API_BASE}/me`, {
            headers: {
              Authorization: `Bearer ${data.accessToken}`,
              'Content-Type': 'application/json',
            },
            credentials: 'include',
          });
          if (meRes.ok) {
            const user = await meRes.json();
            set({ user, accessToken: data.accessToken });
          } else {
            set({ accessToken: data.accessToken });
          }
          return true;
        } catch {
          set({ user: null, accessToken: null });
          return false;
        }
      },

      initialize: async () => {
        set({ isLoading: true });
        try {
          await get().refreshSession();
        } finally {
          set({ isLoading: false });
        }
      },

      completeOnboarding: () => {
        const { user, accessToken } = get();
        if (!user) return;
        set({ user: { ...user, onboarded: true } });
        fetch(`${API_BASE}/complete-onboarding`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
          },
          credentials: 'include',
        }).catch(() => {});
      },

      clearError: () => set({ error: null }),
    }),
    {
      name: 'botmem-auth',
      partialize: (state) => ({ user: state.user }),
    },
  ),
);
