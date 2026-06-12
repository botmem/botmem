import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useConnectorStore } from '../connectorStore';

vi.mock('../../lib/api', () => ({
  api: {
    listConnectors: vi.fn(),
    listAccounts: vi.fn(),
    createAccount: vi.fn(),
    deleteAccount: vi.fn(),
    updateAccount: vi.fn(),
    triggerSync: vi.fn(),
    listJobs: vi.fn(),
    listLogs: vi.fn(),
  },
}));

import { api } from '../../lib/api';

describe('connectorStore', () => {
  beforeEach(() => {
    useConnectorStore.setState({ accounts: [], manifests: [], loading: false, error: null });
    vi.clearAllMocks();
  });

  describe('fetchManifests', () => {
    it('fetches and sets manifests', async () => {
      (api.listConnectors as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
        connectors: [{ id: 'gmail', name: 'Gmail' }],
      });
      await useConnectorStore.getState().fetchManifests();
      expect(useConnectorStore.getState().manifests).toHaveLength(1);
    });

    it('handles API error gracefully', async () => {
      (api.listConnectors as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('fail'),
      );
      await useConnectorStore.getState().fetchManifests();
      expect(useConnectorStore.getState().manifests).toEqual([]);
    });
  });

  describe('fetchAccounts', () => {
    it('fetches and sets accounts', async () => {
      (api.listAccounts as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
        accounts: [{ id: 'a1' }],
      });
      await useConnectorStore.getState().fetchAccounts();
      expect(useConnectorStore.getState().accounts).toHaveLength(1);
    });

    it('handles API error gracefully', async () => {
      (api.listAccounts as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('fail'),
      );
      await useConnectorStore.getState().fetchAccounts();
      expect(useConnectorStore.getState().accounts).toEqual([]);
    });
  });

  describe('addAccount', () => {
    it('adds account from API response', async () => {
      const account = { id: 'a1', type: 'gmail', identifier: 'test', status: 'connected' };
      (api.createAccount as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(account);
      await useConnectorStore.getState().addAccount('gmail', 'test');
      expect(useConnectorStore.getState().accounts).toHaveLength(1);
      expect(useConnectorStore.getState().accounts[0].id).toBe('a1');
    });

    it('does not create a local connected account on API failure', async () => {
      (api.createAccount as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('fail'),
      );
      await expect(useConnectorStore.getState().addAccount('gmail', 'test')).rejects.toThrow(
        'fail',
      );
      expect(useConnectorStore.getState().accounts).toEqual([]);
      expect(useConnectorStore.getState().error).toBe('fail');
    });

    it('sends selected schedule when creating an account', async () => {
      const account = { id: 'a1', type: 'gmail', identifier: 'test', status: 'connected' };
      (api.createAccount as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(account);
      (api.listAccounts as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
        accounts: [account],
      });
      await useConnectorStore.getState().addAccount('gmail', 'test', 'hourly');
      expect(api.createAccount).toHaveBeenCalledWith({
        connectorType: 'gmail',
        identifier: 'test',
        schedule: 'hourly',
      });
    });
  });

  describe('removeAccount', () => {
    it('removes account from state', async () => {
      useConnectorStore.setState({
        accounts: [
          {
            id: 'a1',
            type: 'gmail',
            identifier: 'test',
            status: 'connected',
            schedule: 'manual',
            lastSync: null,
            memoriesIngested: 0,
            contactsCount: 0,
            groupsCount: 0,
            lastError: null,
          },
        ],
      });
      (api.deleteAccount as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({});
      await useConnectorStore.getState().removeAccount('a1');
      expect(useConnectorStore.getState().accounts).toHaveLength(0);
    });

    it('removes from state even on API failure', async () => {
      useConnectorStore.setState({
        accounts: [
          {
            id: 'a1',
            type: 'gmail',
            identifier: 'test',
            status: 'connected',
            schedule: 'manual',
            lastSync: null,
            memoriesIngested: 0,
            contactsCount: 0,
            groupsCount: 0,
            lastError: null,
          },
        ],
      });
      (api.deleteAccount as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('fail'),
      );
      await useConnectorStore.getState().removeAccount('a1');
      expect(useConnectorStore.getState().accounts).toHaveLength(0);
    });
  });

  describe('updateSchedule', () => {
    it('updates schedule in state', async () => {
      useConnectorStore.setState({
        accounts: [
          {
            id: 'a1',
            type: 'gmail',
            identifier: 'test',
            status: 'connected',
            schedule: 'manual',
            lastSync: null,
            memoriesIngested: 0,
            contactsCount: 0,
            groupsCount: 0,
            lastError: null,
          },
        ],
      });
      (api.updateAccount as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({});
      await useConnectorStore.getState().updateSchedule('a1', 'hourly');
      expect(useConnectorStore.getState().accounts[0].schedule).toBe('hourly');
    });
  });

  describe('syncNow', () => {
    it('sets syncing status and calls API', async () => {
      useConnectorStore.setState({
        accounts: [
          {
            id: 'a1',
            type: 'gmail',
            identifier: 'test',
            status: 'connected',
            schedule: 'manual',
            lastSync: null,
            memoriesIngested: 0,
            contactsCount: 0,
            groupsCount: 0,
            lastError: null,
          },
        ],
      });
      (api.triggerSync as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
        job: { id: 'j1' },
      });

      await useConnectorStore.getState().syncNow('a1');
      expect(api.triggerSync).toHaveBeenCalledWith('a1', undefined);
    });

    it('refetches backend account state on API failure', async () => {
      useConnectorStore.setState({
        accounts: [
          {
            id: 'a1',
            type: 'gmail',
            identifier: 'test',
            status: 'connected',
            schedule: 'manual',
            lastSync: null,
            memoriesIngested: 0,
            contactsCount: 0,
            groupsCount: 0,
            lastError: null,
          },
        ],
      });
      (api.triggerSync as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('fail'));
      (api.listAccounts as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
        accounts: [
          {
            id: 'a1',
            type: 'gmail',
            identifier: 'test',
            status: 'failed',
            schedule: 'manual',
            lastSync: null,
            memoriesIngested: 0,
            contactsCount: 0,
            groupsCount: 0,
            lastError: 'bridge not connected',
          },
        ],
      });
      await useConnectorStore.getState().syncNow('a1');
      expect(api.listAccounts).toHaveBeenCalled();
      expect(useConnectorStore.getState().accounts[0].status).toBe('failed');
      expect(useConnectorStore.getState().accounts[0].lastError).toBe('bridge not connected');
    });
  });
});
