import type { Auth } from 'firebase/auth';
import type { Analytics } from 'firebase/analytics';

const isFirebaseMode = import.meta.env.VITE_AUTH_PROVIDER === 'firebase';

let _auth: Auth | null = null;
let _googleProvider: InstanceType<typeof import('firebase/auth').GoogleAuthProvider> | null = null;
let _githubProvider: InstanceType<typeof import('firebase/auth').GithubAuthProvider> | null = null;
let _analyticsPromise: Promise<Analytics | null> = Promise.resolve(null);

if (isFirebaseMode) {
  const { initializeApp, getApps } = await import('firebase/app');
  const { getAuth, GoogleAuthProvider, GithubAuthProvider } = await import('firebase/auth');
  const { getAnalytics, isSupported } = await import('firebase/analytics');

  const firebaseConfig = {
    apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
    authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
    storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
    appId: import.meta.env.VITE_FIREBASE_APP_ID,
    measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID,
  };

  // Guard against double-init in HMR / test environments
  const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];

  _auth = getAuth(app);
  _googleProvider = new GoogleAuthProvider();
  _githubProvider = new GithubAuthProvider();

  // Analytics only runs in browser environments that support it (not SSR/Node)
  _analyticsPromise = isSupported().then((yes) => (yes ? getAnalytics(app) : null));
}

export const firebaseAuth = _auth;
export const googleProvider = _googleProvider;
export const githubProvider = _githubProvider;
export const analyticsPromise = _analyticsPromise;
