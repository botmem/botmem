import { describe, it, expect, beforeEach, vi } from 'vitest';

// Provide a working localStorage before importing the store
const store: Record<string, string> = {};
const localStorageMock = {
  getItem: vi.fn((key: string) => store[key] ?? null),
  setItem: vi.fn((key: string, value: string) => { store[key] = value; }),
  removeItem: vi.fn((key: string) => { delete store[key]; }),
  clear: vi.fn(() => { Object.keys(store).forEach((k) => delete store[k]); }),
  get length() { return Object.keys(store).length; },
  key: vi.fn((i: number) => Object.keys(store)[i] ?? null),
};
vi.stubGlobal('localStorage', localStorageMock);

// Import store AFTER stubbing localStorage so persist middleware picks it up
const { useAuthStore } = await import('../authStore');

describe('authStore', () => {
  beforeEach(() => {
    Object.keys(store).forEach((k) => delete store[k]);
    vi.clearAllMocks();
    useAuthStore.setState({ user: null });
  });

  describe('signup', () => {
    it('creates user and sets state', () => {
      useAuthStore.getState().signup('test@test.com', 'pass', 'Test User');
      const user = useAuthStore.getState().user;
      expect(user).not.toBeNull();
      expect(user!.email).toBe('test@test.com');
      expect(user!.name).toBe('Test User');
      expect(user!.onboarded).toBe(false);
    });

    it('persists user to localStorage', () => {
      useAuthStore.getState().signup('test@test.com', 'pass', 'Test');
      const stored = store['botmem-users'];
      expect(stored).toBeTruthy();
      const users = JSON.parse(stored!);
      expect(users).toHaveLength(1);
      expect(users[0].email).toBe('test@test.com');
    });
  });

  describe('login', () => {
    it('returns true and sets user when found', () => {
      const users = [{ id: 'u1', email: 'test@test.com', name: 'Test', onboarded: true }];
      store['botmem-users'] = JSON.stringify(users);

      const result = useAuthStore.getState().login('test@test.com', 'pass');
      expect(result).toBe(true);
      expect(useAuthStore.getState().user?.email).toBe('test@test.com');
    });

    it('returns false when user not found', () => {
      store['botmem-users'] = JSON.stringify([]);
      const result = useAuthStore.getState().login('unknown@test.com', 'pass');
      expect(result).toBe(false);
      expect(useAuthStore.getState().user).toBeNull();
    });

    it('handles empty localStorage', () => {
      const result = useAuthStore.getState().login('test@test.com', 'pass');
      expect(result).toBe(false);
    });
  });

  describe('logout', () => {
    it('clears user state', () => {
      useAuthStore.setState({ user: { id: 'u1', email: 'test@test.com', name: 'Test', onboarded: true } });
      useAuthStore.getState().logout();
      expect(useAuthStore.getState().user).toBeNull();
    });
  });

  describe('completeOnboarding', () => {
    it('sets onboarded to true', () => {
      const user = { id: 'u1', email: 'test@test.com', name: 'Test', onboarded: false };
      store['botmem-users'] = JSON.stringify([user]);
      useAuthStore.setState({ user });

      useAuthStore.getState().completeOnboarding();
      expect(useAuthStore.getState().user!.onboarded).toBe(true);
    });

    it('does nothing when no user', () => {
      useAuthStore.setState({ user: null });
      useAuthStore.getState().completeOnboarding();
      expect(useAuthStore.getState().user).toBeNull();
    });
  });
});
