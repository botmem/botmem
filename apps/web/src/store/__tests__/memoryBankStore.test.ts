import { describe, it, expect, beforeEach, vi } from 'vitest';

// Stub localStorage
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

// Mock the api module
vi.mock('../../lib/api', () => ({
  api: {
    listMemoryBanks: vi.fn(),
    createMemoryBank: vi.fn(),
    renameMemoryBank: vi.fn(),
    deleteMemoryBank: vi.fn(),
  },
}));

import { api } from '../../lib/api';
const { useMemoryBankStore } = await import('../memoryBankStore');

const mockBanks = [
  {
    id: 'b1',
    name: 'Default',
    isDefault: true,
    memoryCount: 10,
    createdAt: '2025-01-01',
    updatedAt: '2025-01-01',
  },
  {
    id: 'b2',
    name: 'Work',
    isDefault: false,
    memoryCount: 5,
    createdAt: '2025-01-02',
    updatedAt: '2025-01-02',
  },
];

describe('memoryBankStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useMemoryBankStore.setState({
      memoryBanks: [],
      activeMemoryBankId: null,
      loading: false,
    });
    Object.keys(store).forEach((k) => delete store[k]);
  });

  describe('loadMemoryBanks', () => {
    it('loads banks from API', async () => {
      vi.mocked(api.listMemoryBanks).mockResolvedValue({ memoryBanks: mockBanks } as never);

      await useMemoryBankStore.getState().loadMemoryBanks();

      expect(useMemoryBankStore.getState().memoryBanks).toEqual(mockBanks);
      expect(useMemoryBankStore.getState().loading).toBe(false);
    });

    it('resets activeMemoryBankId if bank no longer exists', async () => {
      useMemoryBankStore.setState({ activeMemoryBankId: 'deleted-id' });
      store['botmem:activeMemoryBankId'] = 'deleted-id';

      vi.mocked(api.listMemoryBanks).mockResolvedValue({ memoryBanks: mockBanks } as never);

      await useMemoryBankStore.getState().loadMemoryBanks();

      expect(useMemoryBankStore.getState().activeMemoryBankId).toBeNull();
    });

    it('keeps activeMemoryBankId if bank still exists', async () => {
      useMemoryBankStore.setState({ activeMemoryBankId: 'b1' });

      vi.mocked(api.listMemoryBanks).mockResolvedValue({ memoryBanks: mockBanks } as never);

      await useMemoryBankStore.getState().loadMemoryBanks();

      expect(useMemoryBankStore.getState().activeMemoryBankId).toBe('b1');
    });

    it('handles API error gracefully', async () => {
      vi.mocked(api.listMemoryBanks).mockRejectedValue(new Error('Network error'));

      await useMemoryBankStore.getState().loadMemoryBanks();

      expect(useMemoryBankStore.getState().loading).toBe(false);
      expect(useMemoryBankStore.getState().memoryBanks).toEqual([]);
    });
  });

  describe('createMemoryBank', () => {
    it('creates bank and reloads', async () => {
      vi.mocked(api.createMemoryBank).mockResolvedValue(undefined as never);
      vi.mocked(api.listMemoryBanks).mockResolvedValue({
        memoryBanks: [...mockBanks, { id: 'b3', name: 'New' }],
      } as never);

      await useMemoryBankStore.getState().createMemoryBank('New');

      expect(api.createMemoryBank).toHaveBeenCalledWith('New');
      expect(api.listMemoryBanks).toHaveBeenCalled();
    });

    it('throws on API error', async () => {
      vi.mocked(api.createMemoryBank).mockRejectedValue(new Error('Conflict'));

      await expect(useMemoryBankStore.getState().createMemoryBank('Dup')).rejects.toThrow(
        'Conflict',
      );
    });
  });

  describe('renameMemoryBank', () => {
    it('renames bank locally and on API', async () => {
      useMemoryBankStore.setState({ memoryBanks: mockBanks });
      vi.mocked(api.renameMemoryBank).mockResolvedValue(undefined as never);

      await useMemoryBankStore.getState().renameMemoryBank('b2', 'Personal');

      const banks = useMemoryBankStore.getState().memoryBanks;
      expect(banks.find((b) => b.id === 'b2')!.name).toBe('Personal');
    });

    it('throws on API error', async () => {
      vi.mocked(api.renameMemoryBank).mockRejectedValue(new Error('Not found'));

      await expect(useMemoryBankStore.getState().renameMemoryBank('x', 'Y')).rejects.toThrow(
        'Not found',
      );
    });
  });

  describe('deleteMemoryBank', () => {
    it('deletes bank and reloads', async () => {
      useMemoryBankStore.setState({ memoryBanks: mockBanks, activeMemoryBankId: 'b2' });
      vi.mocked(api.deleteMemoryBank).mockResolvedValue(undefined as never);
      vi.mocked(api.listMemoryBanks).mockResolvedValue({ memoryBanks: [mockBanks[0]] } as never);

      await useMemoryBankStore.getState().deleteMemoryBank('b2');

      expect(useMemoryBankStore.getState().activeMemoryBankId).toBeNull();
    });

    it('keeps activeMemoryBankId when deleting a different bank', async () => {
      useMemoryBankStore.setState({ memoryBanks: mockBanks, activeMemoryBankId: 'b1' });
      vi.mocked(api.deleteMemoryBank).mockResolvedValue(undefined as never);
      vi.mocked(api.listMemoryBanks).mockResolvedValue({ memoryBanks: [mockBanks[0]] } as never);

      await useMemoryBankStore.getState().deleteMemoryBank('b2');

      expect(useMemoryBankStore.getState().activeMemoryBankId).toBe('b1');
    });

    it('throws on API error', async () => {
      vi.mocked(api.deleteMemoryBank).mockRejectedValue(new Error('Forbidden'));

      await expect(useMemoryBankStore.getState().deleteMemoryBank('b1')).rejects.toThrow(
        'Forbidden',
      );
    });
  });

  describe('setActiveMemoryBank', () => {
    it('sets active bank and persists to localStorage', () => {
      useMemoryBankStore.getState().setActiveMemoryBank('b1');

      expect(useMemoryBankStore.getState().activeMemoryBankId).toBe('b1');
      expect(store['botmem:activeMemoryBankId']).toBe('b1');
    });

    it('clears active bank and removes from localStorage', () => {
      store['botmem:activeMemoryBankId'] = 'b1';
      useMemoryBankStore.getState().setActiveMemoryBank(null);

      expect(useMemoryBankStore.getState().activeMemoryBankId).toBeNull();
      expect(store['botmem:activeMemoryBankId']).toBeUndefined();
    });
  });
});
