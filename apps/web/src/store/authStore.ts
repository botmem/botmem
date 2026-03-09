import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { User } from '@botmem/shared';
import { signInWithPopup, signOut as firebaseSignOut, getIdToken } from 'firebase/auth';
import { firebaseAuth, googleProvider, githubProvider } from '../lib/firebase';

interface AuthState {
  user: User | null;
  accessToken: string | null;
  isLoading: boolean;
  error: string | null;
  login: (email: string, password: string) => Promise<void>;
  signup: (email: string, password: string, name: string) => Promise<void>;
  logout: () => Promise<void>;
  reauth: (password: string) => Promise<void>;
  refreshSession: () => Promise<boolean>;
  initialize: () => Promise<void>;
  completeOnboarding: () => void;
  clearError: () => void;
  loginWithFirebase: (provider: 'google' | 'github') => Promise<void>;
}

export const isFirebaseMode = import.meta.env.VITE_AUTH_PROVIDER === 'firebase';

const API_BASE = '/api/user-auth';

// Mutex: only one refresh call at a time to prevent token rotation race
let activeRefresh: Promise<boolean> | null = null;

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

      reauth: async (password: string) => {
        const { accessToken } = get();
        const res = await fetch(`${API_BASE}/reauth`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
          },
          credentials: 'include',
          body: JSON.stringify({ password }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({ message: `Error ${res.status}` }));
          throw new Error(body.message || `Error ${res.status}`);
        }
      },

      logout: async () => {
        // Sign out of Firebase if in firebase mode
        if (isFirebaseMode && firebaseAuth.currentUser) {
          await firebaseSignOut(firebaseAuth).catch(() => {});
        }
        try {
          await authFetch('/logout', { method: 'POST' });
        } catch {
          // Logout should always clear state even if API call fails
        }
        set({ user: null, accessToken: null, error: null });
      },

      refreshSession: async (): Promise<boolean> => {
        // Deduplicate concurrent refresh calls — prevents token rotation race
        if (activeRefresh) return activeRefresh;

        activeRefresh = (async () => {
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
        })();

        try {
          return await activeRefresh;
        } finally {
          activeRefresh = null;
        }
      },

      initialize: async () => {
        set({ isLoading: true });
        try {
          if (isFirebaseMode) {
            // Wait for Firebase auth state to resolve
            await new Promise<void>((resolve) => {
              const unsubscribe = firebaseAuth.onAuthStateChanged(async (firebaseUser) => {
                unsubscribe();
                if (firebaseUser) {
                  const idToken = await getIdToken(firebaseUser);
                  const res = await fetch('/api/firebase-auth/sync', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ idToken }),
                  });
                  if (res.ok) {
                    const { user: freshUser } = await res.json();
                    const localUser = get().user;
                    const merged = {
                      ...freshUser,
                      onboarded: freshUser.onboarded || localUser?.onboarded || false,
                    };
                    set({ user: merged, accessToken: idToken });
                  } else {
                    set({ user: null, accessToken: null });
                  }
                } else {
                  set({ user: null, accessToken: null });
                }
                resolve();
              });
            });
          } else {
            await get().refreshSession();
          }
        } finally {
          set({ isLoading: false });
        }
      },

      completeOnboarding: async () => {
        const { user, accessToken } = get();
        if (!user) return;
        set({ user: { ...user, onboarded: true } });
        try {
          await fetch(`${API_BASE}/complete-onboarding`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
            },
            credentials: 'include',
          });
        } catch (err) {
          console.error(
            '[authStore] completeOnboarding: backend call failed, keeping local state',
            err,
          );
        }
      },

      clearError: () => set({ error: null }),

      loginWithFirebase: async (provider: 'google' | 'github') => {
        set({ error: null, isLoading: true });
        try {
          const authProvider = provider === 'google' ? googleProvider : githubProvider;
          const result = await signInWithPopup(firebaseAuth, authProvider);

          // Get the Firebase ID token
          const idToken = await getIdToken(result.user);

          // Sync with backend to create/retrieve local user record
          const res = await fetch('/api/firebase-auth/sync', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ idToken }),
          });
          if (!res.ok) {
            const body = await res.json().catch(() => ({ message: 'Sync failed' }));
            throw new Error(body.message || 'Backend sync failed');
          }
          const { user } = await res.json();

          // Store Firebase ID token as the accessToken — used for Bearer auth on all API calls
          set({ user, accessToken: idToken, isLoading: false });
        } catch (err: any) {
          // Firebase popup closed by user is not an error
          if (
            err.code === 'auth/popup-closed-by-user' ||
            err.code === 'auth/cancelled-popup-request'
          ) {
            set({ isLoading: false });
            return;
          }
          set({ error: err.message || 'Firebase login failed', isLoading: false });
          throw err;
        }
      },
    }),
    {
      name: 'botmem-auth',
      partialize: (state) => ({ user: state.user, accessToken: state.accessToken }),
    },
  ),
);

// Sync auth state across tabs — when one tab rotates the refresh token,
// the other tab picks up the new access token from localStorage
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === 'botmem-auth' && e.newValue) {
      try {
        const parsed = JSON.parse(e.newValue);
        const { user, accessToken } = parsed.state || {};
        useAuthStore.setState({ user: user ?? null, accessToken: accessToken ?? null });
      } catch {
        // Ignore malformed storage
      }
    }
  });
}
