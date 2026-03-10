import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { User } from '@botmem/shared';
import {
  signInWithPopup,
  signOut as firebaseSignOut,
  getIdToken,
  createUserWithEmailAndPassword,
  sendEmailVerification,
} from 'firebase/auth';
import { firebaseAuth, googleProvider, githubProvider } from '../lib/firebase';

interface AuthState {
  user: User | null;
  accessToken: string | null;
  isLoading: boolean;
  error: string | null;
  recoveryKey: string | null;
  needsRecoveryKey: boolean;
  login: (email: string, password: string) => Promise<void>;
  signup: (email: string, password: string, name: string) => Promise<void>;
  logout: () => Promise<void>;
  submitRecoveryKey: (recoveryKey: string) => Promise<void>;
  dismissRecoveryKey: () => void;
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
      recoveryKey: null,
      needsRecoveryKey: false,

      login: async (email: string, password: string) => {
        set({ error: null, isLoading: true });
        try {
          const data = await authFetch<{
            accessToken: string;
            user: User;
            needsRecoveryKey?: boolean;
            recoveryKey?: string;
          }>('/login', {
            method: 'POST',
            body: JSON.stringify({ email, password }),
          });
          set({
            user: data.user,
            accessToken: data.accessToken,
            isLoading: false,
            needsRecoveryKey: !!data.needsRecoveryKey,
            recoveryKey: data.recoveryKey ?? null,
          });
        } catch (err: unknown) {
          set({ error: err instanceof Error ? err.message : 'Login failed', isLoading: false });
          throw err;
        }
      },

      signup: async (email: string, password: string, name: string) => {
        set({ error: null, isLoading: true });
        try {
          if (isFirebaseMode) {
            // Create user in Firebase, send verification email, then sync with backend
            const cred = await createUserWithEmailAndPassword(firebaseAuth, email, password);
            await sendEmailVerification(cred.user);
            const idToken = await getIdToken(cred.user);

            // Sync with backend (creates local user + recovery key)
            const res = await fetch('/api/firebase-auth/sync', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ idToken, name }),
            });
            if (!res.ok) {
              const body = await res.json().catch(() => ({ message: 'Signup sync failed' }));
              throw new Error(body.message || 'Backend sync failed');
            }
            const data = await res.json();
            set({
              user: data.user,
              accessToken: idToken,
              isLoading: false,
              recoveryKey: data.recoveryKey ?? null,
            });
          } else {
            // Local mode — direct API registration
            const data = await authFetch<{
              accessToken: string;
              user: User;
              recoveryKey?: string;
            }>('/register', {
              method: 'POST',
              body: JSON.stringify({ email, password, name }),
            });
            set({
              user: data.user,
              accessToken: data.accessToken,
              isLoading: false,
              recoveryKey: data.recoveryKey ?? null,
            });
          }
        } catch (err: unknown) {
          // Map Firebase error codes to friendly messages
          const fbErr = err as { code?: string; message?: string };
          const msg =
            fbErr.code === 'auth/email-already-in-use'
              ? 'This email is already registered'
              : fbErr.code === 'auth/weak-password'
                ? 'Password must be at least 6 characters'
                : err instanceof Error
                  ? err.message
                  : 'Signup failed';
          set({ error: msg, isLoading: false });
          throw err;
        }
      },

      submitRecoveryKey: async (recoveryKey: string) => {
        const { accessToken } = get();
        const res = await fetch(`${API_BASE}/recovery-key`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
          },
          credentials: 'include',
          body: JSON.stringify({ recoveryKey }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({ message: `Error ${res.status}` }));
          throw new Error(body.message || `Error ${res.status}`);
        }
        set({ needsRecoveryKey: false });
      },

      dismissRecoveryKey: () => set({ recoveryKey: null }),

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
          const data = await res.json();

          // Store Firebase ID token as the accessToken — used for Bearer auth on all API calls
          set({
            user: data.user,
            accessToken: idToken,
            isLoading: false,
            recoveryKey: data.recoveryKey ?? null,
            needsRecoveryKey: !!data.needsRecoveryKey,
          });
        } catch (err: unknown) {
          // Firebase popup closed by user is not an error
          const fbErr = err as { code?: string; message?: string };
          if (
            fbErr.code === 'auth/popup-closed-by-user' ||
            fbErr.code === 'auth/cancelled-popup-request'
          ) {
            set({ isLoading: false });
            return;
          }
          set({
            error: err instanceof Error ? err.message : 'Firebase login failed',
            isLoading: false,
          });
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
