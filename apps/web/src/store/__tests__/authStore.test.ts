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
    useAuthStore.setState({
      user: null,
      accessToken: null,
      error: null,
      isLoading: false,
      needsRecoveryKey: false,
      recoveryKey: null,
    });
  });

  describe('signup', () => {
    it('sets user and accessToken on success', async () => {
      mockFetch.mockReturnValueOnce(okResponse({ user: mockUser, accessToken: mockAccessToken }));
      await useAuthStore.getState().signup('test@test.com', 'pass', 'Test User');
      expect(useAuthStore.getState().user).toEqual(mockUser);
      expect(useAuthStore.getState().accessToken).toBe(mockAccessToken);
    });

    it('stores recovery key when provided', async () => {
      mockFetch.mockReturnValueOnce(okResponse({
        user: mockUser,
        accessToken: mockAccessToken,
        recoveryKey: 'rec-key-123',
      }));
      await useAuthStore.getState().signup('test@test.com', 'pass', 'Test');
      expect(useAuthStore.getState().recoveryKey).toBe('rec-key-123');
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

    it('sets needsRecoveryKey when flagged', async () => {
      mockFetch.mockReturnValueOnce(okResponse({
        user: mockUser,
        accessToken: mockAccessToken,
        needsRecoveryKey: true,
      }));
      await useAuthStore.getState().login('test@test.com', 'pass');
      expect(useAuthStore.getState().needsRecoveryKey).toBe(true);
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

  describe('submitRecoveryKey', () => {
    it('submits recovery key and clears needsRecoveryKey', async () => {
      useAuthStore.setState({ accessToken: 'tok', needsRecoveryKey: true });
      mockFetch.mockReturnValueOnce(okResponse({}));

      await useAuthStore.getState().submitRecoveryKey('my-recovery-key');

      expect(useAuthStore.getState().needsRecoveryKey).toBe(false);
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/user-auth/recovery-key',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ recoveryKey: 'my-recovery-key' }),
        }),
      );
    });

    it('includes Authorization header when accessToken is present', async () => {
      useAuthStore.setState({ accessToken: 'tok-123' });
      mockFetch.mockReturnValueOnce(okResponse({}));

      await useAuthStore.getState().submitRecoveryKey('key');

      const fetchCall = mockFetch.mock.calls[0];
      expect(fetchCall[1].headers.Authorization).toBe('Bearer tok-123');
    });

    it('throws on failure', async () => {
      mockFetch.mockReturnValueOnce(failResponse(400, 'Invalid key'));

      await expect(useAuthStore.getState().submitRecoveryKey('bad-key')).rejects.toThrow('Invalid key');
    });
  });

  describe('dismissRecoveryKey', () => {
    it('clears recoveryKey', () => {
      useAuthStore.setState({ recoveryKey: 'some-key' });
      useAuthStore.getState().dismissRecoveryKey();
      expect(useAuthStore.getState().recoveryKey).toBeNull();
    });
  });

  describe('refreshSession', () => {
    it('refreshes token and fetches user profile', async () => {
      mockFetch
        .mockReturnValueOnce(okResponse({ accessToken: 'new-token' }))
        .mockReturnValueOnce(okResponse(mockUser));

      const result = await useAuthStore.getState().refreshSession();

      expect(result).toBe(true);
      expect(useAuthStore.getState().accessToken).toBe('new-token');
      expect(useAuthStore.getState().user).toEqual(mockUser);
    });

    it('sets accessToken even if /me fails', async () => {
      mockFetch
        .mockReturnValueOnce(okResponse({ accessToken: 'new-token' }))
        .mockReturnValueOnce(failResponse(500, 'Server error'));

      const result = await useAuthStore.getState().refreshSession();

      expect(result).toBe(true);
      expect(useAuthStore.getState().accessToken).toBe('new-token');
    });

    it('clears state on refresh failure', async () => {
      useAuthStore.setState({ user: mockUser, accessToken: 'old' });
      mockFetch.mockReturnValueOnce(failResponse(401, 'Expired'));

      const result = await useAuthStore.getState().refreshSession();

      expect(result).toBe(false);
      expect(useAuthStore.getState().user).toBeNull();
      expect(useAuthStore.getState().accessToken).toBeNull();
    });

    it('deduplicates concurrent refresh calls', async () => {
      mockFetch
        .mockReturnValueOnce(okResponse({ accessToken: 'new-tok' }))
        .mockReturnValueOnce(okResponse(mockUser));

      // Call refresh twice concurrently
      const [r1, r2] = await Promise.all([
        useAuthStore.getState().refreshSession(),
        useAuthStore.getState().refreshSession(),
      ]);

      expect(r1).toBe(true);
      expect(r2).toBe(true);
      // Should only have made one refresh call (2 fetches: /refresh + /me)
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('initialize', () => {
    it('calls refreshSession in non-firebase mode', async () => {
      mockFetch
        .mockReturnValueOnce(okResponse({ accessToken: 'init-tok' }))
        .mockReturnValueOnce(okResponse(mockUser));

      await useAuthStore.getState().initialize();

      expect(useAuthStore.getState().isLoading).toBe(false);
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

    it('keeps local state even if backend call fails', async () => {
      useAuthStore.setState({ user: { ...mockUser, onboarded: false }, accessToken: 'tok' });
      mockFetch.mockRejectedValueOnce(new Error('network'));

      await useAuthStore.getState().completeOnboarding();

      expect(useAuthStore.getState().user!.onboarded).toBe(true);
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
