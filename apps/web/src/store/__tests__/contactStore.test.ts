import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useContactStore } from '../contactStore';

vi.mock('../../lib/api', () => ({
  api: {
    listContacts: vi.fn(),
    searchContacts: vi.fn(),
    getMergeSuggestions: vi.fn(),
    updateContact: vi.fn(),
    mergeContacts: vi.fn(),
    deleteContact: vi.fn(),
    dismissSuggestion: vi.fn(),
    undismissSuggestion: vi.fn(),
    removeIdentifier: vi.fn(),
    splitContact: vi.fn(),
  },
}));

import { api } from '../../lib/api';

const rawContact = (id: string, name: string) => ({
  id,
  displayName: name,
  entityType: 'person',
  avatars: [],
  identifiers: [
    { id: `id-${id}`, identifierType: 'email', identifierValue: `${name.toLowerCase()}@test.com`, isPrimary: true, connectorType: 'gmail' },
  ],
  memoryCount: 5,
  createdAt: '2026-01-01',
  updatedAt: '2026-01-01',
});

describe('contactStore', () => {
  beforeEach(() => {
    useContactStore.setState({
      contacts: [],
      total: 0,
      suggestions: [],
      selectedId: null,
      searchQuery: '',
      loading: false,
      loadingMore: false,
      hasMore: true,
      entityFilter: 'person',
    });
    vi.clearAllMocks();
  });

  describe('loadContacts', () => {
    it('fetches and sets contacts', async () => {
      (api.listContacts as any).mockResolvedValue({
        items: [rawContact('c1', 'Alice'), rawContact('c2', 'Bob')],
        total: 2,
      });
      await useContactStore.getState().loadContacts();
      const state = useContactStore.getState();
      expect(state.contacts).toHaveLength(2);
      expect(state.contacts[0].displayName).toBe('Alice');
      expect(state.total).toBe(2);
      expect(state.hasMore).toBe(false);
      expect(state.loading).toBe(false);
    });

    it('handles API error', async () => {
      (api.listContacts as any).mockRejectedValue(new Error('fail'));
      await useContactStore.getState().loadContacts();
      expect(useContactStore.getState().contacts).toEqual([]);
      expect(useContactStore.getState().loading).toBe(false);
    });

    it('passes entityType parameter', async () => {
      (api.listContacts as any).mockResolvedValue({ items: [], total: 0 });
      await useContactStore.getState().loadContacts('organization');
      expect(api.listContacts).toHaveBeenCalledWith(expect.objectContaining({ entityType: 'organization' }));
    });

    it('parses identifiers correctly', async () => {
      (api.listContacts as any).mockResolvedValue({
        items: [rawContact('c1', 'Alice')],
        total: 1,
      });
      await useContactStore.getState().loadContacts();
      const contact = useContactStore.getState().contacts[0];
      expect(contact.identifiers[0].type).toBe('email');
      expect(contact.identifiers[0].value).toBe('alice@test.com');
      expect(contact.connectorSources).toEqual(['gmail']);
    });

    it('sets hasMore when more contacts available', async () => {
      (api.listContacts as any).mockResolvedValue({
        items: [rawContact('c1', 'Alice')],
        total: 200,
      });
      await useContactStore.getState().loadContacts();
      expect(useContactStore.getState().hasMore).toBe(true);
    });
  });

  describe('loadMoreContacts', () => {
    it('appends more contacts', async () => {
      useContactStore.setState({
        contacts: [{ id: 'c1', displayName: 'Alice', entityType: 'person', avatars: [], identifiers: [], connectorSources: [], memoryCount: 1, createdAt: '', updatedAt: '' }],
        total: 2,
        hasMore: true,
      });
      (api.listContacts as any).mockResolvedValue({
        items: [rawContact('c2', 'Bob')],
        total: 2,
      });
      await useContactStore.getState().loadMoreContacts();
      expect(useContactStore.getState().contacts).toHaveLength(2);
      expect(useContactStore.getState().hasMore).toBe(false);
    });

    it('does not load if already loading', async () => {
      useContactStore.setState({ loadingMore: true, hasMore: true });
      await useContactStore.getState().loadMoreContacts();
      expect(api.listContacts).not.toHaveBeenCalled();
    });

    it('does not load if no more', async () => {
      useContactStore.setState({ hasMore: false });
      await useContactStore.getState().loadMoreContacts();
      expect(api.listContacts).not.toHaveBeenCalled();
    });

    it('does not load if search query is active', async () => {
      useContactStore.setState({ searchQuery: 'alice', hasMore: true });
      await useContactStore.getState().loadMoreContacts();
      expect(api.listContacts).not.toHaveBeenCalled();
    });

    it('handles API error', async () => {
      useContactStore.setState({ hasMore: true, contacts: [] });
      (api.listContacts as any).mockRejectedValue(new Error('fail'));
      await useContactStore.getState().loadMoreContacts();
      expect(useContactStore.getState().loadingMore).toBe(false);
    });
  });

  describe('searchContacts', () => {
    it('searches and sets results', async () => {
      (api.searchContacts as any).mockResolvedValue([rawContact('c1', 'Alice')]);
      await useContactStore.getState().searchContacts('alice');
      const state = useContactStore.getState();
      expect(state.contacts).toHaveLength(1);
      expect(state.total).toBe(1);
      expect(state.loading).toBe(false);
    });

    it('handles search error', async () => {
      (api.searchContacts as any).mockRejectedValue(new Error('fail'));
      await useContactStore.getState().searchContacts('alice');
      expect(useContactStore.getState().loading).toBe(false);
    });
  });

  describe('selectContact', () => {
    it('selects a contact', () => {
      useContactStore.getState().selectContact('c1');
      expect(useContactStore.getState().selectedId).toBe('c1');
    });

    it('deselects with null', () => {
      useContactStore.setState({ selectedId: 'c1' });
      useContactStore.getState().selectContact(null);
      expect(useContactStore.getState().selectedId).toBeNull();
    });
  });

  describe('setEntityFilter', () => {
    it('sets filter and triggers load', async () => {
      (api.listContacts as any).mockResolvedValue({ items: [], total: 0 });
      useContactStore.getState().setEntityFilter('organization');
      expect(useContactStore.getState().entityFilter).toBe('organization');
      expect(useContactStore.getState().selectedId).toBeNull();
    });
  });

  describe('updateContact', () => {
    it('updates contact in list', async () => {
      useContactStore.setState({
        contacts: [{ id: 'c1', displayName: 'Old Name', entityType: 'person', avatars: [], identifiers: [], connectorSources: [], memoryCount: 1, createdAt: '', updatedAt: '' }],
      });
      (api.updateContact as any).mockResolvedValue({ id: 'c1', displayName: 'New Name', entityType: 'person', avatars: [], identifiers: [] });
      await useContactStore.getState().updateContact('c1', { displayName: 'New Name' });
      expect(useContactStore.getState().contacts[0].displayName).toBe('New Name');
    });
  });

  describe('deleteContact', () => {
    it('removes contact from list', async () => {
      useContactStore.setState({
        contacts: [
          { id: 'c1', displayName: 'Alice', entityType: 'person', avatars: [], identifiers: [], connectorSources: [], memoryCount: 1, createdAt: '', updatedAt: '' },
          { id: 'c2', displayName: 'Bob', entityType: 'person', avatars: [], identifiers: [], connectorSources: [], memoryCount: 1, createdAt: '', updatedAt: '' },
        ],
        total: 2,
        selectedId: 'c1',
      });
      (api.deleteContact as any).mockResolvedValue({});
      await useContactStore.getState().deleteContact('c1');
      const state = useContactStore.getState();
      expect(state.contacts).toHaveLength(1);
      expect(state.total).toBe(1);
      expect(state.selectedId).toBeNull();
    });

    it('preserves selectedId if different contact deleted', async () => {
      useContactStore.setState({
        contacts: [
          { id: 'c1', displayName: 'Alice', entityType: 'person', avatars: [], identifiers: [], connectorSources: [], memoryCount: 1, createdAt: '', updatedAt: '' },
          { id: 'c2', displayName: 'Bob', entityType: 'person', avatars: [], identifiers: [], connectorSources: [], memoryCount: 1, createdAt: '', updatedAt: '' },
        ],
        total: 2,
        selectedId: 'c2',
      });
      (api.deleteContact as any).mockResolvedValue({});
      await useContactStore.getState().deleteContact('c1');
      expect(useContactStore.getState().selectedId).toBe('c2');
    });
  });

  describe('loadSuggestions', () => {
    it('loads merge suggestions', async () => {
      (api.getMergeSuggestions as any).mockResolvedValue([
        { contact1: rawContact('c1', 'Alice'), contact2: rawContact('c2', 'Alice K'), reason: 'Similar names' },
      ]);
      await useContactStore.getState().loadSuggestions();
      expect(useContactStore.getState().suggestions).toHaveLength(1);
      expect(useContactStore.getState().suggestions[0].reason).toBe('Similar names');
    });
  });

  describe('dismissSuggestion', () => {
    it('removes suggestion from list', async () => {
      useContactStore.setState({
        suggestions: [
          { contact1: { id: 'c1', displayName: 'A', entityType: 'person', avatars: [], identifiers: [], connectorSources: [], memoryCount: 0, createdAt: '', updatedAt: '' }, contact2: { id: 'c2', displayName: 'B', entityType: 'person', avatars: [], identifiers: [], connectorSources: [], memoryCount: 0, createdAt: '', updatedAt: '' }, reason: 'test' },
        ],
      });
      (api.dismissSuggestion as any).mockResolvedValue({});
      await useContactStore.getState().dismissSuggestion('c1', 'c2');
      expect(useContactStore.getState().suggestions).toHaveLength(0);
    });
  });

  describe('reinsertSuggestion', () => {
    it('prepends suggestion', () => {
      const suggestion = { contact1: { id: 'c1', displayName: 'A', entityType: 'person', avatars: [], identifiers: [], connectorSources: [], memoryCount: 0, createdAt: '', updatedAt: '' }, contact2: { id: 'c2', displayName: 'B', entityType: 'person', avatars: [], identifiers: [], connectorSources: [], memoryCount: 0, createdAt: '', updatedAt: '' }, reason: 'test' };
      useContactStore.getState().reinsertSuggestion(suggestion);
      expect(useContactStore.getState().suggestions).toHaveLength(1);
    });
  });

  describe('undismissSuggestion', () => {
    it('calls API to undismiss', async () => {
      (api.undismissSuggestion as any).mockResolvedValue({});
      await useContactStore.getState().undismissSuggestion('c1', 'c2');
      expect(api.undismissSuggestion).toHaveBeenCalledWith('c1', 'c2');
    });

    it('handles error gracefully', async () => {
      (api.undismissSuggestion as any).mockRejectedValue(new Error('fail'));
      await useContactStore.getState().undismissSuggestion('c1', 'c2');
    });
  });

  describe('mergeContacts', () => {
    it('merges contacts and reloads', async () => {
      useContactStore.setState({ selectedId: 'c2' });
      (api.mergeContacts as any).mockResolvedValue({});
      (api.listContacts as any).mockResolvedValue({ items: [rawContact('c1', 'Alice')], total: 1 });
      (api.getMergeSuggestions as any).mockResolvedValue([]);
      await useContactStore.getState().mergeContacts('c1', 'c2');
      expect(useContactStore.getState().selectedId).toBe('c1');
    });

    it('handles merge error', async () => {
      (api.mergeContacts as any).mockRejectedValue(new Error('fail'));
      await useContactStore.getState().mergeContacts('c1', 'c2');
    });
  });

  describe('removeIdentifier', () => {
    it('removes identifier and updates contact', async () => {
      useContactStore.setState({
        contacts: [{ id: 'c1', displayName: 'Alice', entityType: 'person', avatars: [], identifiers: [{ id: 'id-1', type: 'email', value: 'a@test.com', isPrimary: true }], connectorSources: [], memoryCount: 1, createdAt: '', updatedAt: '' }],
      });
      (api.removeIdentifier as any).mockResolvedValue({ id: 'c1', displayName: 'Alice', entityType: 'person', avatars: [], identifiers: [] });
      await useContactStore.getState().removeIdentifier('c1', 'id-1');
      expect(useContactStore.getState().contacts[0].identifiers).toEqual([]);
    });

    it('handles error gracefully', async () => {
      (api.removeIdentifier as any).mockRejectedValue(new Error('fail'));
      await useContactStore.getState().removeIdentifier('c1', 'id-1');
    });
  });

  describe('splitContact', () => {
    it('splits contact and reloads', async () => {
      (api.splitContact as any).mockResolvedValue({});
      (api.listContacts as any).mockResolvedValue({ items: [], total: 0 });
      await useContactStore.getState().splitContact('c1', ['id-1']);
      expect(api.splitContact).toHaveBeenCalledWith('c1', ['id-1']);
    });

    it('handles error gracefully', async () => {
      (api.splitContact as any).mockRejectedValue(new Error('fail'));
      await useContactStore.getState().splitContact('c1', ['id-1']);
    });
  });

  describe('setSearchQuery', () => {
    it('sets search query', () => {
      useContactStore.getState().setSearchQuery('test');
      expect(useContactStore.getState().searchQuery).toBe('test');
    });
  });
});
