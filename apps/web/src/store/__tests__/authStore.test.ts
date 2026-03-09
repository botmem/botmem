import { describe, it, expect, beforeEach, vi } from 'vitest';

// Stub localStorage for zustand persist middleware
const store: Record<string, string> = {};
vi.stubGlobal('localStorage', {
  getItem: (key: string) => store[key] ?? null,
  setItem: (key: string, value: string) => {
    store[key] = value;
  },
  removeItem: (key: string) => {
    delete store[key];
  },
  clear: () => {
    Object.keys(store).forEach((k) => delete store[k]);
  },
  get length() {
    return Object.keys(store).length;
  },
  key: (i: number) => Object.keys(store)[i] ?? null,
});

// Mock fetch globally before importing the store
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Import store AFTER stubbing globals
const { useAuthStore } = await import('../authStore');

const mockUser = { id: 'u1', email: 'test@test.com', name: 'Test User', onboarded: false };
const mockAccessToken = 'token-abc';

function okResponse(body: unknown) {
  return Promise.resolve({
    ok: true,
    json: () => Promise.resolve(body),
  } as Response);
}

function failResponse(status: number, message: string) {
  return Promise.resolve({
    ok: false,
    status,
    json: () => Promise.resolve({ message }),
  } as Response);
}

describe('authStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuthStore.setState({ user: null, accessToken: null, error: null, isLoading: false });
  });

  describe('signup', () => {
    it('sets user and accessToken on success', async () => {
      mockFetch.mockReturnValueOnce(okResponse({ user: mockUser, accessToken: mockAccessToken }));
      await useAuthStore.getState().signup('test@test.com', 'pass', 'Test User');
      expect(useAuthStore.getState().user).toEqual(mockUser);
      expect(useAuthStore.getState().accessToken).toBe(mockAccessToken);
    });

    it('sets error on failure', async () => {
      mockFetch.mockReturnValueOnce(failResponse(400, 'Email already taken'));
      await expect(useAuthStore.getState().signup('test@test.com', 'pass', 'Test')).rejects.toThrow(
        'Email already taken',
      );
      expect(useAuthStore.getState().error).toBe('Email already taken');
      expect(useAuthStore.getState().user).toBeNull();
    });
  });

  describe('login', () => {
    it('sets user and accessToken on success', async () => {
      mockFetch.mockReturnValueOnce(okResponse({ user: mockUser, accessToken: mockAccessToken }));
      await useAuthStore.getState().login('test@test.com', 'pass');
      expect(useAuthStore.getState().user).toEqual(mockUser);
      expect(useAuthStore.getState().accessToken).toBe(mockAccessToken);
    });

    it('sets error on failure', async () => {
      mockFetch.mockReturnValueOnce(failResponse(401, 'Invalid credentials'));
      await expect(useAuthStore.getState().login('x@x.com', 'wrong')).rejects.toThrow(
        'Invalid credentials',
      );
      expect(useAuthStore.getState().error).toBe('Invalid credentials');
    });
  });

  describe('logout', () => {
    it('clears user and accessToken', async () => {
      useAuthStore.setState({ user: mockUser, accessToken: mockAccessToken });
      mockFetch.mockReturnValueOnce(okResponse({}));
      await useAuthStore.getState().logout();
      expect(useAuthStore.getState().user).toBeNull();
      expect(useAuthStore.getState().accessToken).toBeNull();
    });

    it('clears state even if API call fails', async () => {
      useAuthStore.setState({ user: mockUser, accessToken: mockAccessToken });
      mockFetch.mockRejectedValueOnce(new Error('network'));
      await useAuthStore.getState().logout();
      expect(useAuthStore.getState().user).toBeNull();
    });
  });

  describe('completeOnboarding', () => {
    it('sets onboarded to true', () => {
      useAuthStore.setState({
        user: { ...mockUser, onboarded: false },
        accessToken: mockAccessToken,
      });
      mockFetch.mockReturnValueOnce(okResponse({}));
      useAuthStore.getState().completeOnboarding();
      expect(useAuthStore.getState().user!.onboarded).toBe(true);
    });

    it('does nothing when no user', () => {
      useAuthStore.setState({ user: null });
      useAuthStore.getState().completeOnboarding();
      expect(useAuthStore.getState().user).toBeNull();
    });
  });

  describe('clearError', () => {
    it('clears error state', () => {
      useAuthStore.setState({ error: 'some error' });
      useAuthStore.getState().clearError();
      expect(useAuthStore.getState().error).toBeNull();
    });
  });
});
