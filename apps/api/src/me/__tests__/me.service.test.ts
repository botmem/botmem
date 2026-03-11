import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MeService } from '../me.service';
import type { DbService } from '../../db/db.service';

describe('MeService', () => {
  let service: MeService;
  let mockDb: Record<string, ReturnType<typeof vi.fn>>;
  let cryptoService: {
    decrypt: ReturnType<typeof vi.fn>;
    decryptWithKey: ReturnType<typeof vi.fn>;
  };
  let userKeyService: { getKey: ReturnType<typeof vi.fn> };
  let contactsService: { resolveContact: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockDb = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      groupBy: vi.fn().mockReturnValue([]),
      innerJoin: vi.fn().mockReturnThis(),
      insert: vi.fn().mockReturnThis(),
      values: vi.fn().mockReturnThis(),
      update: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
      onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
    };

    cryptoService = {
      decrypt: vi.fn().mockImplementation((v: string) => v),
      decryptWithKey: vi.fn().mockImplementation((v: string) => v),
    };

    userKeyService = {
      getKey: vi.fn().mockReturnValue(Buffer.from('testkey')),
    };

    contactsService = {
      resolveContact: vi.fn().mockResolvedValue({ id: 'contact-1' }),
    };

    service = new MeService(
      { db: mockDb } as unknown as DbService,
      cryptoService,
      userKeyService,
      contactsService,
    );
  });

  describe('setSelfContact', () => {
    it('sets self contact when contact exists', async () => {
      mockDb.where.mockResolvedValueOnce([{ id: 'c-1' }]); // contact exists
      const result = await service.setSelfContact('c-1', 'user-1');
      expect(result).toEqual({ ok: true });
      expect(mockDb.insert).toHaveBeenCalled();
    });

    it('throws if contact not found', async () => {
      mockDb.where.mockResolvedValueOnce([]); // no contact
      await expect(service.setSelfContact('bad-id')).rejects.toThrow('Contact bad-id not found');
    });
  });

  describe('getStatus', () => {
    it('returns isSet true when self contact found via settings', async () => {
      // resolveSelfContactId: settings lookup returns value
      mockDb.where
        .mockResolvedValueOnce([{ key: 'selfContactId:user-1', value: 'c-1' }])
        // verify contact exists
        .mockResolvedValueOnce([{ id: 'c-1' }]);

      const result = await service.getStatus('user-1');
      expect(result.isSet).toBe(true);
      expect(result.contactId).toBe('c-1');
    });

    it('returns isSet false when no self contact', async () => {
      // settings lookup returns nothing
      mockDb.where
        .mockResolvedValueOnce([]) // per-user setting
        .mockResolvedValueOnce([]) // global setting fallback
        // detectSelfContactId: no accounts
        .mockResolvedValueOnce([]);

      const result = await service.getStatus('user-1');
      expect(result.isSet).toBe(false);
      expect(result.contactId).toBeNull();
    });
  });

  describe('setPreferredAvatar', () => {
    it('updates preferred avatar index', async () => {
      // resolveSelfContactId returns contact
      mockDb.where
        .mockResolvedValueOnce([{ key: 'selfContactId:user-1', value: 'c-1' }])
        .mockResolvedValueOnce([{ id: 'c-1' }]);
      mockDb.set.mockReturnThis();
      mockDb.where.mockResolvedValueOnce(undefined);

      const result = await service.setPreferredAvatar('user-1', 2);
      expect(result).toEqual({ ok: true });
      expect(mockDb.update).toHaveBeenCalled();
    });

    it('throws if self contact not set', async () => {
      mockDb.where.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([]);

      await expect(service.setPreferredAvatar('user-1', 0)).rejects.toThrow('Self contact not set');
    });
  });

  describe('getMergeCandidates', () => {
    it('returns empty when no self contact', async () => {
      mockDb.where
        .mockResolvedValueOnce([]) // per-user setting
        .mockResolvedValueOnce([]) // global fallback
        .mockResolvedValueOnce([]); // no accounts (detectSelfContactId)

      const result = await service.getMergeCandidates('user-1');
      expect(result).toEqual([]);
    });

    it('returns empty when self contact name too short', async () => {
      mockDb.where
        .mockResolvedValueOnce([{ key: 'selfContactId:user-1', value: 'c-1' }])
        .mockResolvedValueOnce([{ id: 'c-1' }]) // verify exists
        .mockResolvedValueOnce([{ id: 'c-1', displayName: 'A', userId: 'user-1' }]); // self contact with short name

      const result = await service.getMergeCandidates('user-1');
      expect(result).toEqual([]);
    });

    it('finds candidates with shared identifiers', async () => {
      // resolveSelfContactId
      mockDb.where
        .mockResolvedValueOnce([{ key: 'selfContactId:user-1', value: 'c-1' }])
        .mockResolvedValueOnce([{ id: 'c-1' }])
        // Load self contact
        .mockResolvedValueOnce([{ id: 'c-1', displayName: 'John Smith', userId: 'user-1' }])
        // Self identifiers
        .mockResolvedValueOnce([
          { identifierType: 'email', identifierValue: 'john@test.com', contactId: 'c-1' },
        ])
        // Dismissed pairs
        .mockResolvedValueOnce([])
        // All persons (candidates)
        .mockResolvedValueOnce([
          { id: 'c-2', displayName: 'John S', entityType: 'person', userId: 'user-1' },
        ])
        // c-2's identifiers (shares email)
        .mockResolvedValueOnce([
          { identifierType: 'email', identifierValue: 'john@test.com', contactId: 'c-2' },
        ])
        // c-2's identifiers for display
        .mockResolvedValueOnce([
          { identifierType: 'email', identifierValue: 'john@test.com', connectorType: 'gmail' },
        ]);

      const result = await service.getMergeCandidates('user-1');
      expect(result).toHaveLength(1);
      expect(result[0].reason).toContain('Shares email');
    });
  });

  // NOTE: getMe() has very deep DB call chains that are impractical to mock.
  // It is better tested via integration tests with a real database.
});
