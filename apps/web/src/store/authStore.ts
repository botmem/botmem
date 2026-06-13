import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { User } from '@botmem/shared';
import { firebaseAuth, googleProvider, githubProvider, ensureFirebase } from '../lib/firebase';
import { trackEvent, resetUser, identifyUser } from '../lib/posthog';
import { API_BASE as ROOT_API_BASE } from '../lib/urls';

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

// Shared auth-provider state (avoids circular imports with firebase.ts)
import { isFirebaseMode, detectAuthProvider } from '../lib/auth-provider';
export { isFirebaseMode, detectAuthProvider };

const API_BASE = `${ROOT_API_BASE}/user-auth`;
const PENDING_RECOVERY_KEY_STORAGE_KEY = 'botmem.pendingRecoveryKey';

// Mutex: only one refresh call at a time to prevent token rotation race
let activeRefresh: Promise<boolean> | null = null;
let firebaseTokenUnsubscribe: (() => void) | null = null;

function readPendingRecoveryKey() {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage.getItem(PENDING_RECOVERY_KEY_STORAGE_KEY);
  } catch {
    return null;
  }
}

function keepRecoveryKey(recoveryKey?: string | null) {
  if (!recoveryKey) return readPendingRecoveryKey();
  if (typeof window !== 'undefined') {
    // ponytail: sessionStorage survives reload but not browser-session end; localStorage would persist plaintext too long.
    try {
      window.sessionStorage.setItem(PENDING_RECOVERY_KEY_STORAGE_KEY, recoveryKey);
    } catch {
      // Keep showing the in-memory key; failing closed here would hide the only recovery path.
    }
  }
  return recoveryKey;
}

function clearPendingRecoveryKey() {
  if (typeof window !== 'undefined') {
    try {
      window.sessionStorage.removeItem(PENDING_RECOVERY_KEY_STORAGE_KEY);
    } catch {
      // Nothing else to clear.
    }
  }
}

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

/** Lazy-load firebase/auth functions and ensure Firebase is initialized */
async function getFirebaseAuthFns() {
  await ensureFirebase();
  const {
    signInWithPopup,
    signOut,
    getIdToken,
    createUserWithEmailAndPassword,
    sendEmailVerification,
  } = await import('firebase/auth');
  return {
    signInWithPopup,
    signOut,
    getIdToken,
    createUserWithEmailAndPassword,
    sendEmailVerification,
  };
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
          trackEvent('login', { method: 'email' });
          if (data.user.email) {
            identifyUser(data.user.id, {
              email: data.user.email,
              name: data.user.name ?? undefined,
            });
          }
          set({
            user: data.user,
            accessToken: data.accessToken,
            isLoading: false,
            needsRecoveryKey: !!data.needsRecoveryKey,
            recoveryKey: keepRecoveryKey(data.recoveryKey),
          });
        } catch (err: unknown) {
          trackEvent('login_failed', {
            method: 'email',
            error: err instanceof Error ? err.message : 'unknown',
          });
          set({ error: err instanceof Error ? err.message : 'Login failed', isLoading: false });
          throw err;
        }
      },

      signup: async (email: string, password: string, name: string) => {
        set({ error: null, isLoading: true });
        try {
          if (isFirebaseMode && firebaseAuth) {
            const { createUserWithEmailAndPassword, sendEmailVerification, getIdToken } =
              await getFirebaseAuthFns();
            // Create user in Firebase, send verification email, then sync with backend
            const cred = await createUserWithEmailAndPassword(firebaseAuth, email, password);
            await sendEmailVerification(cred.user);
            const idToken = await getIdToken(cred.user);

            // Sync with backend (creates local user + recovery key)
            const res = await fetch(`${ROOT_API_BASE}/firebase-auth/sync`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ idToken, name }),
            });
            if (!res.ok) {
              const body = await res.json().catch(() => ({ message: 'Signup sync failed' }));
              throw new Error(body.message || 'Backend sync failed');
            }
            const data = await res.json();
            trackEvent('signup', { method: 'firebase_email' });
            if (data.user?.email) {
              identifyUser(data.user.id, {
                email: data.user.email,
                name: data.user.name ?? name,
              });
            }
            set({
              user: data.user,
              accessToken: idToken,
              isLoading: false,
              recoveryKey: keepRecoveryKey(data.recoveryKey),
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
            trackEvent('signup', { method: 'email' });
            if (data.user.email) {
              identifyUser(data.user.id, {
                email: data.user.email,
                name: data.user.name ?? name,
              });
            }
            set({
              user: data.user,
              accessToken: data.accessToken,
              isLoading: false,
              recoveryKey: keepRecoveryKey(data.recoveryKey),
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
          trackEvent('signup_failed', { error: msg });
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

      dismissRecoveryKey: () => {
        clearPendingRecoveryKey();
        set({ recoveryKey: null });
      },

      logout: async () => {
        trackEvent('logout');
        // Sign out of Firebase if in firebase mode
        if (isFirebaseMode) {
          await ensureFirebase();
        }
        if (isFirebaseMode && firebaseAuth?.currentUser) {
          const { signOut } = await getFirebaseAuthFns();
          await signOut(firebaseAuth).catch(() => {});
        }
        try {
          await authFetch('/logout', { method: 'POST' });
        } catch {
          // Logout should always clear state even if API call fails
        }
        resetUser();
        set({ user: null, accessToken: null, error: null, recoveryKey: null });
      },

      refreshSession: async (): Promise<boolean> => {
        // Deduplicate concurrent refresh calls — prevents token rotation race
        if (activeRefresh) return activeRefresh;

        activeRefresh = (async () => {
          try {
            if (isFirebaseMode) {
              await ensureFirebase();
              if (!firebaseAuth?.currentUser) throw new Error('No Firebase user');
              const { getIdToken } = await getFirebaseAuthFns();
              const idToken = await getIdToken(firebaseAuth.currentUser, true);
              set({ accessToken: idToken });
              return true;
            }

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
              if (user.email) {
                identifyUser(user.id, {
                  email: user.email,
                  name: user.name ?? undefined,
                });
              }
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
        // Do not trust persisted partial users during boot. Firebase/local refresh must
        // establish a fresh token before protected routes render and call APIs.
        set({
          isLoading: true,
          user: null,
          accessToken: null,
          recoveryKey: readPendingRecoveryKey(),
        });
        try {
          if (isFirebaseMode) {
            await ensureFirebase();
          }
          if (isFirebaseMode && firebaseAuth) {
            const { getIdToken } = await getFirebaseAuthFns();
            const { getRedirectResult, onIdTokenChanged } = await import('firebase/auth');

            if (!firebaseTokenUnsubscribe) {
              firebaseTokenUnsubscribe = onIdTokenChanged(firebaseAuth, async (firebaseUser) => {
                if (!firebaseUser) {
                  set({ user: null, accessToken: null });
                  return;
                }
                try {
                  set({ accessToken: await getIdToken(firebaseUser) });
                } catch {
                  set({ user: null, accessToken: null });
                }
              });
            }

            // Helper: sync a Firebase user with our backend
            const syncUser = async (firebaseUser: import('firebase/auth').User) => {
              const idToken = await getIdToken(firebaseUser);
              const res = await fetch(`${ROOT_API_BASE}/firebase-auth/sync`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ idToken }),
              });
              if (res.ok) {
                const data = await res.json();
                const localUser = get().user;
                const merged = {
                  ...data.user,
                  onboarded: data.user.onboarded || localUser?.onboarded || false,
                };
                if (merged.email) {
                  identifyUser(merged.id, {
                    email: merged.email,
                    name: merged.name ?? undefined,
                  });
                }
                trackEvent('login', { method: 'firebase' });
                set({
                  user: merged,
                  accessToken: idToken,
                  recoveryKey: keepRecoveryKey(data.recoveryKey),
                  needsRecoveryKey: !!data.needsRecoveryKey,
                });
                return true;
              }
              return false;
            };

            // Check for legacy redirect results before the current popup flow.
            try {
              const redirectResult = await getRedirectResult(firebaseAuth!);
              if (redirectResult?.user) {
                await syncUser(redirectResult.user);
              }
            } catch (err) {
              console.warn('[authStore] getRedirectResult error:', err);
            }

            // Then check current auth state (session persistence / already logged in).
            // A persisted partial user can exist without an access token, so gate on token.
            if (!get().accessToken) {
              await new Promise<void>((resolve) => {
                const unsubscribe = firebaseAuth!.onAuthStateChanged(async (firebaseUser) => {
                  unsubscribe();
                  if (firebaseUser) {
                    await syncUser(firebaseUser);
                  } else {
                    set({ user: null, accessToken: null });
                  }
                  resolve();
                });
              });
            }
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
        trackEvent('onboarding_completed');
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
          await ensureFirebase();
          if (!firebaseAuth) throw new Error('Firebase is not configured');
          const { signInWithPopup, getIdToken } = await getFirebaseAuthFns();
          const authProvider = provider === 'google' ? googleProvider! : githubProvider!;
          const cred = await signInWithPopup(firebaseAuth, authProvider);
          const idToken = await getIdToken(cred.user);
          const res = await fetch(`${ROOT_API_BASE}/firebase-auth/sync`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ idToken }),
          });
          if (!res.ok) {
            const body = await res.json().catch(() => ({ message: 'Login sync failed' }));
            throw new Error(body.message || 'Login sync failed');
          }
          const data = await res.json();
          if (data.user?.email) {
            identifyUser(data.user.id, {
              email: data.user.email,
              name: data.user.name ?? undefined,
            });
          }
          trackEvent('login', { method: `firebase_${provider}` });
          set({
            user: data.user,
            accessToken: idToken,
            recoveryKey: keepRecoveryKey(data.recoveryKey),
            needsRecoveryKey: !!data.needsRecoveryKey,
            isLoading: false,
          });
        } catch (err: unknown) {
          trackEvent('login_failed', {
            method: `firebase_${provider}`,
            error: err instanceof Error ? err.message : 'unknown',
          });
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
      version: 2,
      migrate: () => ({}),
      partialize: () => ({}),
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
        const { user } = parsed.state || {};
        useAuthStore.setState({ user: user ?? null });
      } catch {
        // Ignore malformed storage
      }
    }
  });
}
