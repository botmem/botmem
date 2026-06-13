import { beforeEach, describe, expect, it, vi } from 'vitest';

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

vi.mock('../../lib/posthog', () => ({
  trackEvent: vi.fn(),
}));

import { api } from '../../lib/api';
import { trackEvent } from '../../lib/posthog';
import { useContactStore } from '../contactStore';

const rawAlice = {
  id: 'c1',
  displayName: 'Alice',
  entityType: 'person',
  avatars: JSON.stringify([{ url: '/alice.png', source: 'gmail' }]),
  identifiers: [
    {
      id: 'i1',
      identifierType: 'email',
      identifierValue: 'alice@example.com',
      connectorType: 'gmail',
      isPrimary: true,
    },
  ],
  memoryCount: 4,
  createdAt: '2026-01-01',
  updatedAt: '2026-01-02',
};

const rawBob = {
  id: 'c2',
  displayName: 'Bob',
  entityType: 'person',
  avatars: [],
  identifiers: [
    {
      id: 'i2',
      type: 'phone',
      value: '+15551234567',
      connectorType: 'whatsapp',
      isPrimary: false,
    },
  ],
  memoryCount: 2,
  createdAt: '2026-01-03',
  updatedAt: '2026-01-04',
};

describe('contactStore', () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
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
  });

  it('loads and parses contacts from the API', async () => {
    vi.mocked(api.listContacts).mockResolvedValue({ items: [rawAlice], total: 2 } as never);

    await useContactStore.getState().loadContacts();

    expect(api.listContacts).toHaveBeenCalledWith({ limit: 100, offset: 0, entityType: 'person' });
    expect(useContactStore.getState().contacts[0]).toMatchObject({
      id: 'c1',
      displayName: 'Alice',
      avatars: [{ url: '/alice.png', source: 'gmail' }],
      identifiers: [{ id: 'i1', type: 'email', value: 'alice@example.com', isPrimary: true }],
      connectorSources: ['gmail'],
    });
    expect(useContactStore.getState().hasMore).toBe(true);
    expect(useContactStore.getState().loading).toBe(false);
  });

  it('dedupes identical identifier chips from API contacts', async () => {
    vi.mocked(api.listContacts).mockResolvedValue({
      items: [
        {
          ...rawAlice,
          identifiers: [
            rawAlice.identifiers[0],
            { ...rawAlice.identifiers[0], id: 'i1-duplicate' },
          ],
        },
      ],
      total: 1,
    } as never);

    await useContactStore.getState().loadContacts();

    expect(useContactStore.getState().contacts[0].identifiers).toHaveLength(1);
  });

  it('dedupes WhatsApp group JID variants', async () => {
    vi.mocked(api.listContacts).mockResolvedValue({
      items: [
        {
          ...rawAlice,
          entityType: 'group',
          identifiers: [
            {
              id: 'jid',
              identifierType: 'whatsapp_group_jid',
              identifierValue: '120363123456789@g.us',
            },
            { id: 'phone', identifierType: 'phone', identifierValue: '+120363123456789' },
          ],
        },
      ],
      total: 1,
    } as never);

    await useContactStore.getState().loadContacts('group');

    expect(useContactStore.getState().contacts[0].identifiers).toHaveLength(1);
  });

  it('appends more contacts and skips while searching', async () => {
    useContactStore.setState({ contacts: [rawAlice as any], total: 2, hasMore: true });
    vi.mocked(api.listContacts).mockResolvedValue({ items: [rawBob], total: 2 } as never);

    await useContactStore.getState().loadMoreContacts();

    expect(api.listContacts).toHaveBeenCalledWith({ limit: 100, offset: 1, entityType: 'person' });
    expect(useContactStore.getState().contacts.map((contact) => contact.id)).toEqual(['c1', 'c2']);

    useContactStore.setState({ searchQuery: 'alice', hasMore: true });
    await useContactStore.getState().loadMoreContacts();

    expect(api.listContacts).toHaveBeenCalledTimes(1);
  });

  it('searches contacts, filters by entity type, and tracks usage', async () => {
    vi.mocked(api.searchContacts).mockResolvedValue([
      rawAlice,
      { ...rawBob, id: 'org-1', entityType: 'organization' },
    ] as never);

    await useContactStore.getState().searchContacts('alice');

    expect(api.searchContacts).toHaveBeenCalledWith('alice', 'person');
    expect(useContactStore.getState().contacts).toHaveLength(1);
    expect(trackEvent).toHaveBeenCalledWith('contact_search', {
      query_length: 5,
      result_count: 1,
    });
  });

  it('debounces search query changes', async () => {
    vi.useFakeTimers();
    vi.mocked(api.searchContacts).mockResolvedValue([rawAlice] as never);
    vi.mocked(api.listContacts).mockResolvedValue({ items: [rawBob], total: 1 } as never);

    useContactStore.getState().setSearchQuery('ali');
    await vi.runAllTimersAsync();

    expect(api.searchContacts).toHaveBeenCalledWith('ali', 'person');

    useContactStore.getState().setSearchQuery('');
    await vi.runAllTimersAsync();

    expect(api.listContacts).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('loads merge suggestions and refreshes visible contacts', async () => {
    useContactStore.setState({ contacts: [rawAlice as any], total: 1 });
    vi.mocked(api.getMergeSuggestions).mockResolvedValue([
      { contact1: rawAlice, contact2: rawBob, reason: 'same phone', confidence: 0.9 },
    ] as never);
    vi.mocked(api.listContacts).mockResolvedValue({ items: [rawAlice], total: 1 } as never);

    await useContactStore.getState().loadSuggestions();

    expect(useContactStore.getState().suggestions[0]).toMatchObject({
      reason: 'same phone',
      confidence: 0.9,
      contact1: { id: 'c1' },
      contact2: { id: 'c2' },
    });
    expect(api.listContacts).toHaveBeenCalled();
  });

  it('updates, deletes, and reinserts contacts locally after API calls', async () => {
    useContactStore.setState({
      contacts: [rawAlice as any, rawBob as any],
      total: 2,
      selectedId: 'c1',
    });
    vi.mocked(api.updateContact).mockResolvedValue({
      ...rawAlice,
      displayName: 'Alice A.',
    } as never);
    vi.mocked(api.deleteContact).mockResolvedValue(undefined as never);

    await useContactStore.getState().updateContact('c1', { displayName: 'Alice A.' });
    expect(useContactStore.getState().contacts[0].displayName).toBe('Alice A.');

    await useContactStore.getState().deleteContact('c1');
    expect(useContactStore.getState().contacts.map((contact) => contact.id)).toEqual(['c2']);
    expect(useContactStore.getState().selectedId).toBeNull();
    expect(trackEvent).toHaveBeenCalledWith('contact_deleted');
  });

  it('merges contacts optimistically and reloads on failure', async () => {
    useContactStore.setState({
      contacts: [rawAlice as any, rawBob as any],
      total: 2,
      selectedId: 'c2',
      suggestions: [{ contact1: rawAlice as any, contact2: rawBob as any, reason: 'duplicate' }],
    });
    vi.mocked(api.mergeContacts).mockRejectedValue(new Error('merge failed') as never);
    vi.mocked(api.listContacts).mockResolvedValue({ items: [rawAlice, rawBob], total: 2 } as never);
    vi.mocked(api.getMergeSuggestions).mockResolvedValue([] as never);

    await useContactStore.getState().mergeContacts('c1', 'c2');

    expect(useContactStore.getState().selectedId).toBe('c1');
    expect(api.listContacts).toHaveBeenCalled();
    expect(api.getMergeSuggestions).toHaveBeenCalled();
    expect(trackEvent).toHaveBeenCalledWith('contact_merge');
  });

  it('replaces the target contact with merged API data so source avatars are preserved', async () => {
    useContactStore.setState({
      contacts: [{ ...(rawAlice as any), avatars: [] }, rawBob as any],
      total: 2,
      selectedId: 'c1',
    });
    vi.mocked(api.mergeContacts).mockResolvedValue({
      ...rawAlice,
      avatars: [{ url: '/bob.png', source: 'whatsapp' }],
    } as never);

    await useContactStore.getState().mergeContacts('c1', 'c2');

    expect(useContactStore.getState().contacts).toHaveLength(1);
    expect(useContactStore.getState().contacts[0]).toMatchObject({
      id: 'c1',
      avatars: [{ url: '/bob.png', source: 'whatsapp' }],
    });
  });

  it('dismisses, undismisses, and reinserts suggestions', async () => {
    const suggestion = { contact1: rawAlice as any, contact2: rawBob as any, reason: 'duplicate' };
    useContactStore.setState({ suggestions: [suggestion] });
    vi.mocked(api.dismissSuggestion).mockResolvedValue(undefined as never);
    vi.mocked(api.undismissSuggestion).mockResolvedValue(undefined as never);

    await useContactStore.getState().dismissSuggestion('c2', 'c1');
    expect(useContactStore.getState().suggestions).toEqual([]);

    await useContactStore.getState().undismissSuggestion('c1', 'c2');
    expect(api.undismissSuggestion).toHaveBeenCalledWith('c1', 'c2');

    useContactStore.getState().reinsertSuggestion(suggestion);
    expect(useContactStore.getState().suggestions[0]).toBe(suggestion);
  });

  it('removes identifiers and splits contacts', async () => {
    useContactStore.setState({ contacts: [rawAlice as any] });
    vi.mocked(api.removeIdentifier).mockResolvedValue({
      ...rawAlice,
      identifiers: [],
    } as never);
    vi.mocked(api.splitContact).mockResolvedValue(undefined as never);
    vi.mocked(api.listContacts).mockResolvedValue({ items: [rawAlice], total: 1 } as never);

    await useContactStore.getState().removeIdentifier('c1', 'i1');
    expect(useContactStore.getState().contacts[0].identifiers).toEqual([]);

    await useContactStore.getState().splitContact('c1', ['i1']);
    expect(api.splitContact).toHaveBeenCalledWith('c1', ['i1']);
    expect(trackEvent).toHaveBeenCalledWith('contact_split', { identifier_count: 1 });
    expect(api.listContacts).toHaveBeenCalled();
  });

  it('handles load errors without leaving loading flags stuck', async () => {
    vi.mocked(api.listContacts).mockRejectedValue(new Error('network') as never);

    await useContactStore.getState().loadContacts();

    expect(useContactStore.getState().loading).toBe(false);
  });
});
