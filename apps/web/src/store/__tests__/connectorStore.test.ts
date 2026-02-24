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
  },
}));

import { api } from '../../lib/api';

describe('connectorStore', () => {
  beforeEach(() => {
    useConnectorStore.setState({ accounts: [], manifests: [], loading: false });
    vi.clearAllMocks();
  });

  describe('fetchManifests', () => {
    it('fetches and sets manifests', async () => {
      (api.listConnectors as any).mockResolvedValue({ connectors: [{ id: 'gmail', name: 'Gmail' }] });
      await useConnectorStore.getState().fetchManifests();
      expect(useConnectorStore.getState().manifests).toHaveLength(1);
    });

    it('handles API error gracefully', async () => {
      (api.listConnectors as any).mockRejectedValue(new Error('fail'));
      await useConnectorStore.getState().fetchManifests();
      expect(useConnectorStore.getState().manifests).toEqual([]);
    });
  });

  describe('fetchAccounts', () => {
    it('fetches and sets accounts', async () => {
      (api.listAccounts as any).mockResolvedValue({ accounts: [{ id: 'a1' }] });
      await useConnectorStore.getState().fetchAccounts();
      expect(useConnectorStore.getState().accounts).toHaveLength(1);
    });

    it('handles API error gracefully', async () => {
      (api.listAccounts as any).mockRejectedValue(new Error('fail'));
      await useConnectorStore.getState().fetchAccounts();
      expect(useConnectorStore.getState().accounts).toEqual([]);
    });
  });

  describe('addAccount', () => {
    it('adds account from API response', async () => {
      const account = { id: 'a1', type: 'gmail', identifier: 'test', status: 'connected' };
      (api.createAccount as any).mockResolvedValue(account);
      await useConnectorStore.getState().addAccount('gmail', 'test');
      expect(useConnectorStore.getState().accounts).toHaveLength(1);
      expect(useConnectorStore.getState().accounts[0].id).toBe('a1');
    });

    it('creates local account on API failure', async () => {
      (api.createAccount as any).mockRejectedValue(new Error('fail'));
      await useConnectorStore.getState().addAccount('gmail', 'test');
      const accounts = useConnectorStore.getState().accounts;
      expect(accounts).toHaveLength(1);
      expect(accounts[0].type).toBe('gmail');
      expect(accounts[0].status).toBe('connected');
    });
  });

  describe('removeAccount', () => {
    it('removes account from state', async () => {
      useConnectorStore.setState({
        accounts: [{ id: 'a1', type: 'gmail', identifier: 'test', status: 'connected', schedule: 'manual', lastSync: null, memoriesIngested: 0, lastError: null }],
      });
      (api.deleteAccount as any).mockResolvedValue({});
      await useConnectorStore.getState().removeAccount('a1');
      expect(useConnectorStore.getState().accounts).toHaveLength(0);
    });

    it('removes from state even on API failure', async () => {
      useConnectorStore.setState({
        accounts: [{ id: 'a1', type: 'gmail', identifier: 'test', status: 'connected', schedule: 'manual', lastSync: null, memoriesIngested: 0, lastError: null }],
      });
      (api.deleteAccount as any).mockRejectedValue(new Error('fail'));
      await useConnectorStore.getState().removeAccount('a1');
      expect(useConnectorStore.getState().accounts).toHaveLength(0);
    });
  });

  describe('updateSchedule', () => {
    it('updates schedule in state', async () => {
      useConnectorStore.setState({
        accounts: [{ id: 'a1', type: 'gmail', identifier: 'test', status: 'connected', schedule: 'manual', lastSync: null, memoriesIngested: 0, lastError: null }],
      });
      (api.updateAccount as any).mockResolvedValue({});
      await useConnectorStore.getState().updateSchedule('a1', 'hourly');
      expect(useConnectorStore.getState().accounts[0].schedule).toBe('hourly');
    });
  });

  describe('syncNow', () => {
    it('sets syncing status and calls API', async () => {
      useConnectorStore.setState({
        accounts: [{ id: 'a1', type: 'gmail', identifier: 'test', status: 'connected', schedule: 'manual', lastSync: null, memoriesIngested: 0, lastError: null }],
      });
      (api.triggerSync as any).mockResolvedValue({ job: { id: 'j1' } });

      await useConnectorStore.getState().syncNow('a1');
      expect(api.triggerSync).toHaveBeenCalledWith('a1');
    });

    it('reverts to connected on API failure', async () => {
      useConnectorStore.setState({
        accounts: [{ id: 'a1', type: 'gmail', identifier: 'test', status: 'connected', schedule: 'manual', lastSync: null, memoriesIngested: 0, lastError: null }],
      });
      (api.triggerSync as any).mockRejectedValue(new Error('fail'));
      await useConnectorStore.getState().syncNow('a1');
      expect(useConnectorStore.getState().accounts[0].status).toBe('connected');
    });
  });
});
