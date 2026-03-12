import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';

// vi.hoisted runs before vi.mock hoisting, so these are available in the factory
const { firebaseApps } = vi.hoisted(() => {
  return { firebaseApps: [] as unknown[] };
});

vi.mock('firebase-admin', () => {
  const verifyIdTokenMock = vi.fn();
  const authMock = vi.fn(() => ({ verifyIdToken: verifyIdTokenMock }));
  const certMock = vi.fn(() => 'cert-credential');
  const applicationDefaultMock = vi.fn(() => 'default-credential');
  const initializeAppMock = vi.fn((opts: Record<string, unknown>) => ({
    auth: authMock,
    ...opts,
  }));

  const mod = {
    apps: firebaseApps,
    credential: { cert: certMock, applicationDefault: applicationDefaultMock },
    initializeApp: initializeAppMock,
  };
  return { default: mod, ...mod };
});

import { FirebaseAuthService } from '../firebase-auth.service';

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    firebaseServiceAccount: undefined,
    firebaseProjectId: 'test-project',
    ...overrides,
  } as any;
}

function makeUsersService() {
  return {
    findByFirebaseUid: vi.fn(),
    findById: vi.fn(),
    createUser: vi.fn(),
    setFirebaseUid: vi.fn(),
    updateRecoveryKeyHash: vi.fn(),
    incrementKeyVersion: vi.fn(),
    setOnboarded: vi.fn(),
  } as any;
}

function makeMemoryBanksService() {
  return { getOrCreateDefault: vi.fn() } as any;
}

function makeUserKeyService() {
  return {
    getDek: vi.fn(),
    generateDek: vi.fn(() => Buffer.from('a'.repeat(32))),
    storeDek: vi.fn(),
  } as any;
}

function makeAnalytics() {
  return { capture: vi.fn() } as any;
}

describe('FirebaseAuthService', () => {
  let service: FirebaseAuthService;
  let config: ReturnType<typeof makeConfig>;
  let usersService: ReturnType<typeof makeUsersService>;
  let memoryBanksService: ReturnType<typeof makeMemoryBanksService>;
  let userKeyService: ReturnType<typeof makeUserKeyService>;
  let analytics: ReturnType<typeof makeAnalytics>;

  beforeEach(() => {
    vi.clearAllMocks();
    firebaseApps.length = 0;

    config = makeConfig();
    usersService = makeUsersService();
    memoryBanksService = makeMemoryBanksService();
    userKeyService = makeUserKeyService();
    analytics = makeAnalytics();

    service = new FirebaseAuthService(
      config,
      usersService,
      memoryBanksService,
      userKeyService,
      analytics,
    );
  });

  describe('onModuleInit', () => {
    it('should initialize Firebase Admin with applicationDefault when no service account', async () => {
      const admin = await import('firebase-admin');
      service.onModuleInit();
      expect(admin.default.initializeApp).toHaveBeenCalledWith({
        credential: 'default-credential',
        projectId: 'test-project',
      });
    });

    it('should initialize Firebase Admin with cert when service account provided', async () => {
      const admin = await import('firebase-admin');
      config.firebaseServiceAccount = JSON.stringify({ project_id: 'test' });
      service.onModuleInit();
      expect(admin.default.credential.cert).toHaveBeenCalledWith({ project_id: 'test' });
      expect(admin.default.initializeApp).toHaveBeenCalled();
    });

    it('should reuse existing app when already initialized', async () => {
      const admin = await import('firebase-admin');
      const existingApp = { auth: vi.fn() };
      firebaseApps.push(existingApp);
      (admin.default.initializeApp as any).mockClear();

      const freshService = new FirebaseAuthService(
        config,
        usersService,
        memoryBanksService,
        userKeyService,
        analytics,
      );
      freshService.onModuleInit();
      expect(admin.default.initializeApp).not.toHaveBeenCalled();
    });
  });

  describe('verifyIdToken', () => {
    it('should return decoded token for valid token', async () => {
      const decoded = { uid: 'firebase-uid-1', email: 'test@example.com' };
      const verifyFn = vi.fn().mockResolvedValue(decoded);
      const authFn = vi.fn(() => ({ verifyIdToken: verifyFn }));

      const admin = await import('firebase-admin');
      (admin.default.initializeApp as any).mockReturnValue({ auth: authFn });
      service.onModuleInit();

      const result = await service.verifyIdToken('valid-token');
      expect(result).toEqual(decoded);
      expect(verifyFn).toHaveBeenCalledWith('valid-token');
    });

    it('should throw UnauthorizedException for invalid token', async () => {
      const verifyFn = vi.fn().mockRejectedValue(new Error('Token expired'));
      const authFn = vi.fn(() => ({ verifyIdToken: verifyFn }));

      const admin = await import('firebase-admin');
      (admin.default.initializeApp as any).mockReturnValue({ auth: authFn });
      service.onModuleInit();

      await expect(service.verifyIdToken('bad-token')).rejects.toThrow(UnauthorizedException);
      await expect(service.verifyIdToken('bad-token')).rejects.toThrow('Invalid Firebase ID token');
    });
  });

  describe('findOrCreateUser', () => {
    beforeEach(async () => {
      const verifyFn = vi.fn();
      const authFn = vi.fn(() => ({ verifyIdToken: verifyFn }));
      const admin = await import('firebase-admin');
      (admin.default.initializeApp as any).mockReturnValue({ auth: authFn });
      service.onModuleInit();
    });

    const decodedToken = {
      uid: 'firebase-uid-1',
      email: 'test@example.com',
      name: 'Test User',
      firebase: { sign_in_provider: 'google.com' },
    } as any;

    it('should return existing user with DEK available', async () => {
      const existingUser = {
        id: 'user-1',
        email: 'test@example.com',
        recoveryKeyHash: 'hash',
        onboarded: true,
      };
      usersService.findByFirebaseUid.mockResolvedValue(existingUser);
      userKeyService.getDek.mockResolvedValue(Buffer.from('dek'));

      const result = await service.findOrCreateUser(decodedToken);

      expect(result.user).toEqual(existingUser);
      expect(result.recoveryKey).toBeUndefined();
      expect(result.needsRecoveryKey).toBe(false);
      expect(usersService.setOnboarded).not.toHaveBeenCalled();
      expect(analytics.capture).toHaveBeenCalledWith(
        'user_logged_in',
        { auth_method: 'firebase', firebase_provider: 'google.com' },
        'user-1',
      );
    });

    it('should auto-onboard returning user who is not yet onboarded', async () => {
      const existingUser = {
        id: 'user-1',
        email: 'test@example.com',
        recoveryKeyHash: 'hash',
        onboarded: false,
      };
      usersService.findByFirebaseUid.mockResolvedValue(existingUser);
      userKeyService.getDek.mockResolvedValue(Buffer.from('dek'));

      const result = await service.findOrCreateUser(decodedToken);

      expect(usersService.setOnboarded).toHaveBeenCalledWith('user-1');
      expect(result.user.onboarded).toBe(true);
      expect(result.needsRecoveryKey).toBe(false);
    });

    it('should return existing user with needsRecoveryKey when DEK cache is cold', async () => {
      const existingUser = {
        id: 'user-1',
        email: 'test@example.com',
        recoveryKeyHash: 'hash',
        onboarded: true,
      };
      usersService.findByFirebaseUid.mockResolvedValue(existingUser);
      userKeyService.getDek.mockResolvedValue(null);

      const result = await service.findOrCreateUser(decodedToken);

      expect(result.user).toEqual(existingUser);
      expect(result.needsRecoveryKey).toBe(true);
      expect(result.recoveryKey).toBeUndefined();
    });

    it('should not set needsRecoveryKey when no recoveryKeyHash exists', async () => {
      const existingUser = {
        id: 'user-1',
        email: 'test@example.com',
        recoveryKeyHash: null,
        onboarded: true,
      };
      usersService.findByFirebaseUid.mockResolvedValue(existingUser);
      userKeyService.getDek.mockResolvedValue(null);

      const result = await service.findOrCreateUser(decodedToken);
      expect(result.needsRecoveryKey).toBe(false);
    });

    it('should create new user with recovery key for unknown firebase UID', async () => {
      usersService.findByFirebaseUid.mockResolvedValue(null);
      const newUser = { id: 'new-user-1', email: 'test@example.com', name: 'Test User' };
      usersService.createUser.mockResolvedValue(newUser);
      usersService.findById.mockResolvedValue(newUser);

      const result = await service.findOrCreateUser(decodedToken);

      expect(usersService.createUser).toHaveBeenCalledWith(
        'test@example.com',
        'firebase:firebase-uid-1',
        'Test User',
        expect.any(String),
      );
      expect(usersService.setFirebaseUid).toHaveBeenCalledWith('new-user-1', 'firebase-uid-1');
      expect(usersService.updateRecoveryKeyHash).toHaveBeenCalledWith(
        'new-user-1',
        expect.any(String),
      );
      expect(usersService.incrementKeyVersion).toHaveBeenCalledWith('new-user-1');
      expect(memoryBanksService.getOrCreateDefault).toHaveBeenCalledWith('new-user-1');
      expect(userKeyService.storeDek).toHaveBeenCalledWith('new-user-1', expect.any(Buffer));
      expect(result.recoveryKey).toBeDefined();
      expect(result.needsRecoveryKey).toBe(false);
      expect(result.user).toEqual(newUser);
      expect(analytics.capture).toHaveBeenCalledWith(
        'user_registered',
        { auth_method: 'firebase', firebase_provider: 'google.com' },
        'new-user-1',
      );
    });

    it('should use email prefix as name when decoded.name is absent', async () => {
      usersService.findByFirebaseUid.mockResolvedValue(null);
      usersService.createUser.mockResolvedValue({ id: 'u1' });
      usersService.findById.mockResolvedValue({ id: 'u1' });

      const tokenNoName = { uid: 'uid-2', email: 'hello@world.com', firebase: {} } as any;
      await service.findOrCreateUser(tokenNoName);

      expect(usersService.createUser).toHaveBeenCalledWith(
        'hello@world.com',
        'firebase:uid-2',
        'hello',
        expect.any(String),
      );
    });

    it('should use overrideName when provided', async () => {
      usersService.findByFirebaseUid.mockResolvedValue(null);
      usersService.createUser.mockResolvedValue({ id: 'u1' });
      usersService.findById.mockResolvedValue({ id: 'u1' });

      await service.findOrCreateUser(decodedToken, 'Custom Name');

      expect(usersService.createUser).toHaveBeenCalledWith(
        'test@example.com',
        'firebase:firebase-uid-1',
        'Custom Name',
        expect.any(String),
      );
    });

    it('should fallback to "User" when no name or email', async () => {
      usersService.findByFirebaseUid.mockResolvedValue(null);
      usersService.createUser.mockResolvedValue({ id: 'u1' });
      usersService.findById.mockResolvedValue({ id: 'u1' });

      const tokenNoInfo = { uid: 'uid-3', firebase: {} } as any;
      await service.findOrCreateUser(tokenNoInfo);

      expect(usersService.createUser).toHaveBeenCalledWith(
        'uid-3@firebase.user',
        'firebase:uid-3',
        'User',
        expect.any(String),
      );
    });
  });
});
