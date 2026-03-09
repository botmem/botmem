import { initializeApp, getApps } from 'firebase/app';
import { getAuth, GoogleAuthProvider, GithubAuthProvider } from 'firebase/auth';

const firebaseConfig = {
  apiKey: 'AIzaSyBQQy4khSV7iYDa-QHAgtU9LQi1bq3bOyQ',
  authDomain: 'botmem-app.firebaseapp.com',
  projectId: 'botmem-app',
  storageBucket: 'botmem-app.firebasestorage.app',
  messagingSenderId: '958102222848',
  appId: '1:958102222848:web:1ced1d9c98222557ebc0e5',
};

// Guard against double-init in HMR / test environments
const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];

export const firebaseAuth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();
export const githubProvider = new GithubAuthProvider();
