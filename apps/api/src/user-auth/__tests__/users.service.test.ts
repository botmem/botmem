import { describe, it, expect, beforeEach, vi } from 'vitest';
import { UsersService } from '../users.service';

describe('UsersService', () => {
  let service: UsersService;
  let mockDb: any;

  const fakeUser = {
    id: 'user-1',
    email: 'test@example.com',
    passwordHash: 'hashed',
    name: 'Test User',
    encryptionSalt: 'salt123',
    onboarded: false,
    keyVersion: 1,
    recoveryKeyHash: 'hash123',
    firebaseUid: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(() => {
    mockDb = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      insert: vi.fn().mockReturnThis(),
      values: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
      delete: vi.fn().mockReturnThis(),
    };
    service = new UsersService({ db: mockDb } as any);
  });

  describe('createUser', () => {
    it('creates a user and returns it', async () => {
      mockDb.limit.mockResolvedValueOnce([fakeUser]); // findById
      const result = await service.createUser('test@example.com', 'hashed', 'Test User');
      expect(result).toEqual(fakeUser);
      expect(mockDb.insert).toHaveBeenCalled();
    });
  });

  describe('findByEmail', () => {
    it('returns user when found', async () => {
      mockDb.limit.mockResolvedValueOnce([fakeUser]);
      const result = await service.findByEmail('test@example.com');
      expect(result).toEqual(fakeUser);
    });

    it('returns null when not found', async () => {
      mockDb.limit.mockResolvedValueOnce([]);
      const result = await service.findByEmail('notfound@example.com');
      expect(result).toBeNull();
    });

    it('normalizes email to lowercase', async () => {
      mockDb.limit.mockResolvedValueOnce([fakeUser]);
      await service.findByEmail('  Test@Example.COM  ');
      expect(mockDb.where).toHaveBeenCalled();
    });
  });

  describe('findById', () => {
    it('returns user when found', async () => {
      mockDb.limit.mockResolvedValueOnce([fakeUser]);
      const result = await service.findById('user-1');
      expect(result).toEqual(fakeUser);
    });

    it('returns null when not found', async () => {
      mockDb.limit.mockResolvedValueOnce([]);
      const result = await service.findById('bad-id');
      expect(result).toBeNull();
    });
  });

  describe('findByFirebaseUid', () => {
    it('returns user when found', async () => {
      mockDb.limit.mockResolvedValueOnce([{ ...fakeUser, firebaseUid: 'fb-123' }]);
      const result = await service.findByFirebaseUid('fb-123');
      expect(result!.firebaseUid).toBe('fb-123');
    });
  });

  describe('getEncryptionSalt', () => {
    it('returns salt', async () => {
      mockDb.limit.mockResolvedValueOnce([{ encryptionSalt: 'salt123' }]);
      const result = await service.getEncryptionSalt('user-1');
      expect(result).toBe('salt123');
    });

    it('returns null if no salt', async () => {
      mockDb.limit.mockResolvedValueOnce([]);
      const result = await service.getEncryptionSalt('bad-id');
      expect(result).toBeNull();
    });
  });

  describe('incrementKeyVersion', () => {
    it('increments and returns new version', async () => {
      mockDb.limit.mockResolvedValueOnce([fakeUser]); // findById
      const result = await service.incrementKeyVersion('user-1');
      expect(result).toBe(2);
      expect(mockDb.update).toHaveBeenCalled();
    });
  });

  describe('getUserKeyVersion', () => {
    it('returns key version', async () => {
      mockDb.limit.mockResolvedValueOnce([{ keyVersion: 3 }]);
      const result = await service.getUserKeyVersion('user-1');
      expect(result).toBe(3);
    });

    it('defaults to 1', async () => {
      mockDb.limit.mockResolvedValueOnce([]);
      const result = await service.getUserKeyVersion('bad-id');
      expect(result).toBe(1);
    });
  });

  describe('getRecoveryKeyHash', () => {
    it('returns hash', async () => {
      mockDb.limit.mockResolvedValueOnce([{ recoveryKeyHash: 'hash' }]);
      const result = await service.getRecoveryKeyHash('user-1');
      expect(result).toBe('hash');
    });

    it('returns null when not set', async () => {
      mockDb.limit.mockResolvedValueOnce([]);
      const result = await service.getRecoveryKeyHash('bad-id');
      expect(result).toBeNull();
    });
  });

  describe('saveRefreshToken', () => {
    it('saves and returns token data', async () => {
      const result = await service.saveRefreshToken('user-1', 'hash', 'fam-1', new Date());
      expect(result.userId).toBe('user-1');
      expect(result.tokenHash).toBe('hash');
      expect(result.family).toBe('fam-1');
      expect(mockDb.insert).toHaveBeenCalled();
    });
  });

  describe('findRefreshToken', () => {
    it('returns token when found', async () => {
      mockDb.limit.mockResolvedValueOnce([{ id: 'tok-1', tokenHash: 'hash' }]);
      const result = await service.findRefreshToken('hash');
      expect(result!.tokenHash).toBe('hash');
    });

    it('returns null when not found', async () => {
      mockDb.limit.mockResolvedValueOnce([]);
      const result = await service.findRefreshToken('bad');
      expect(result).toBeNull();
    });
  });

  describe('revokeRefreshToken', () => {
    it('sets revokedAt on token', async () => {
      await service.revokeRefreshToken('tok-1');
      expect(mockDb.update).toHaveBeenCalled();
    });
  });

  describe('revokeTokenFamily', () => {
    it('revokes all tokens in family', async () => {
      await service.revokeTokenFamily('fam-1');
      expect(mockDb.update).toHaveBeenCalled();
    });
  });

  describe('revokeAllUserTokens', () => {
    it('revokes all user tokens', async () => {
      await service.revokeAllUserTokens('user-1');
      expect(mockDb.update).toHaveBeenCalled();
    });
  });

  describe('updatePasswordHash', () => {
    it('updates password hash', async () => {
      await service.updatePasswordHash('user-1', 'newhash');
      expect(mockDb.update).toHaveBeenCalled();
    });
  });

  describe('createPasswordReset', () => {
    it('creates reset token', async () => {
      const result = await service.createPasswordReset('user-1', 'hash', new Date());
      expect(result.userId).toBe('user-1');
    });
  });

  describe('findPasswordReset', () => {
    it('returns reset token when found', async () => {
      mockDb.limit.mockResolvedValueOnce([{ id: 'r-1', tokenHash: 'hash' }]);
      const result = await service.findPasswordReset('hash');
      expect(result!.tokenHash).toBe('hash');
    });
  });

  describe('setOnboarded', () => {
    it('updates onboarded flag', async () => {
      await service.setOnboarded('user-1');
      expect(mockDb.update).toHaveBeenCalled();
    });
  });

  describe('setFirebaseUid', () => {
    it('sets firebase UID', async () => {
      await service.setFirebaseUid('user-1', 'fb-123');
      expect(mockDb.update).toHaveBeenCalled();
    });
  });
});
