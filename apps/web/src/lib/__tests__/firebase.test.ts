import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const auth = {};
  return {
    auth,
    app: {},
    getApps: vi.fn(() => []),
    initializeApp: vi.fn(() => ({})),
    getAuth: vi.fn(() => auth),
    setPersistence: vi.fn(),
    browserLocalPersistence: { type: 'LOCAL' },
    GoogleAuthProvider: vi.fn(),
    GithubAuthProvider: vi.fn(),
  };
});

vi.mock('../auth-provider', () => ({
  isFirebaseMode: true,
}));

vi.mock('firebase/app', () => ({
  getApps: mocks.getApps,
  initializeApp: mocks.initializeApp,
}));

vi.mock('firebase/auth', () => ({
  getAuth: mocks.getAuth,
  setPersistence: mocks.setPersistence,
  browserLocalPersistence: mocks.browserLocalPersistence,
  GoogleAuthProvider: mocks.GoogleAuthProvider,
  GithubAuthProvider: mocks.GithubAuthProvider,
}));

describe('firebase init', () => {
  it('uses browser local persistence', async () => {
    const { ensureFirebase } = await import('../firebase');

    await ensureFirebase();

    expect(mocks.setPersistence).toHaveBeenCalledWith(mocks.auth, mocks.browserLocalPersistence);
  });
});
