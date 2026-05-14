import { API_BASE } from './urls';

/**
 * Runtime auth provider detection.
 * Extracted to its own module to avoid circular imports between authStore and firebase.
 */

// Initial value from build-time env var (fallback for dev mode)
export let isFirebaseMode = import.meta.env.VITE_AUTH_PROVIDER === 'firebase';

/** Called once at app startup to sync auth provider with the server. */
export async function detectAuthProvider(): Promise<void> {
  try {
    const res = await fetch(`${API_BASE}/version`, { credentials: 'include' });
    if (res.ok) {
      const data = await res.json();
      if (data.authProvider) {
        isFirebaseMode = data.authProvider === 'firebase';
      }
    }
  } catch {
    // API not reachable — keep the build-time default
  }
}
