import type { Auth } from 'firebase/auth';

const isFirebaseMode = import.meta.env.VITE_AUTH_PROVIDER === 'firebase';

let _auth: Auth | null = null;
let _googleProvider: InstanceType<typeof import('firebase/auth').GoogleAuthProvider> | null = null;
let _githubProvider: InstanceType<typeof import('firebase/auth').GithubAuthProvider> | null = null;
let _initPromise: Promise<void> | null = null;

function doInit(): Promise<void> {
  if (!_initPromise) {
    _initPromise = (async () => {
      const { initializeApp, getApps } = await import('firebase/app');
      const { getAuth, GoogleAuthProvider, GithubAuthProvider } = await import('firebase/auth');

      const firebaseConfig = {
        apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
        authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
        projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
        storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
        messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
        appId: import.meta.env.VITE_FIREBASE_APP_ID,
      };

      const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];

      _auth = getAuth(app);
      _googleProvider = new GoogleAuthProvider();
      _githubProvider = new GithubAuthProvider();
    })();
  }
  return _initPromise;
}

/** Ensures Firebase is initialized. No-op in local auth mode. */
export async function ensureFirebase() {
  if (!isFirebaseMode) return;
  await doInit();
}

export {
  _auth as firebaseAuth,
  _googleProvider as googleProvider,
  _githubProvider as githubProvider,
};
