import { create } from 'zustand';
import { api } from '../lib/api';
import type { ApiContact } from '../lib/api';

interface Contact {
  id: string;
  displayName: string;
  entityType: string;
  avatars: Array<{ url: string; source: string }>;
  identifiers: Array<{ id: string; type: string; value: string; isPrimary: boolean }>;
  connectorSources: string[];
  memoryCount: number;
  createdAt: string;
  updatedAt: string;
}

interface MergeSuggestion {
  contact1: Contact;
  contact2: Contact;
  reason: string;
}

interface ContactState {
  contacts: Contact[];
  total: number;
  suggestions: MergeSuggestion[];
  selectedId: string | null;
  searchQuery: string;
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  entityFilter: string;
  loadContacts: (entityType?: string) => Promise<void>;
  loadMoreContacts: () => Promise<void>;
  searchContacts: (query: string) => Promise<void>;
  setSearchQuery: (q: string) => void;
  setEntityFilter: (filter: string) => void;
  loadSuggestions: () => Promise<void>;
  selectContact: (id: string | null) => void;
  updateContact: (id: string, data: { displayName?: string }) => Promise<void>;
  mergeContacts: (targetId: string, sourceId: string) => Promise<void>;
  deleteContact: (id: string) => Promise<void>;
  dismissSuggestion: (contactId1: string, contactId2: string) => Promise<void>;
  undismissSuggestion: (contactId1: string, contactId2: string) => Promise<void>;
  reinsertSuggestion: (suggestion: MergeSuggestion) => void;
  removeIdentifier: (contactId: string, identifierId: string) => Promise<void>;
  splitContact: (contactId: string, identifierIds: string[]) => Promise<void>;
}

function parseContact(raw: ApiContact): Contact {
  const identifiers = (raw.identifiers || []).map((i) => ({
    id: i.id,
    type: i.identifierType || i.type || '',
    value: i.identifierValue || i.value || '',
    isPrimary: i.isPrimary || false,
  }));
  const connectorSources = [
    ...new Set((raw.identifiers || []).map((i) => i.connectorType).filter(Boolean)),
  ] as string[];

  return {
    id: raw.id,
    displayName: raw.displayName || '',
    entityType: raw.entityType || 'person',
    avatars: typeof raw.avatars === 'string' ? JSON.parse(raw.avatars) : raw.avatars || [],
    identifiers,
    connectorSources,
    memoryCount: raw.memoryCount || 0,
    createdAt: raw.createdAt || '',
    updatedAt: raw.updatedAt || '',
  };
}

const CONTACT_PAGE_SIZE = 100;
let searchTimer: ReturnType<typeof setTimeout> | null = null;

export const useContactStore = create<ContactState>((set, get) => ({
  contacts: [],
  total: 0,
  suggestions: [],
  selectedId: null,
  searchQuery: '',
  loading: false,
  loadingMore: false,
  hasMore: true,
  entityFilter: 'person',

  loadContacts: async (entityType?: string) => {
    set({ loading: true });
    const filter = entityType ?? get().entityFilter;
    try {
      const result = await api.listContacts({
        limit: CONTACT_PAGE_SIZE,
        offset: 0,
        entityType: filter,
      });
      const contacts = result.items.map(parseContact);
      set({
        contacts,
        total: result.total,
        hasMore: contacts.length < result.total,
        loading: false,
      });
    } catch (err) {
      console.error('Failed to load contacts:', err);
      set({ loading: false });
    }
  },

  loadMoreContacts: async () => {
    const { loadingMore, hasMore, contacts, searchQuery } = get();
    if (loadingMore || !hasMore || searchQuery.trim()) return;
    set({ loadingMore: true });
    try {
      const filter = get().entityFilter;
      const result = await api.listContacts({
        limit: CONTACT_PAGE_SIZE,
        offset: contacts.length,
        entityType: filter,
      });
      const newContacts = result.items.map(parseContact);
      const merged = [...contacts, ...newContacts];
      set({
        contacts: merged,
        total: result.total,
        hasMore: merged.length < result.total,
        loadingMore: false,
      });
    } catch (err) {
      console.error('Failed to load more contacts:', err);
      set({ loadingMore: false });
    }
  },

  searchContacts: async (query: string) => {
    set({ loading: true });
    try {
      const results = await api.searchContacts(query);
      const contacts = results.map(parseContact);
      set({ contacts, total: contacts.length, loading: false });
    } catch (err) {
      console.error('Failed to search contacts:', err);
      set({ loading: false });
    }
  },

  setEntityFilter: (filter) => {
    set({ entityFilter: filter, selectedId: null });
    get().loadContacts(filter);
  },

  setSearchQuery: (query) => {
    set({ searchQuery: query });
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      if (query.trim().length >= 3) {
        get().searchContacts(query);
      } else if (!query.trim()) {
        get().loadContacts();
      }
    }, 500);
  },

  loadSuggestions: async () => {
    try {
      const suggestions = await api.getMergeSuggestions();
      set({
        suggestions: suggestions.map((s) => ({
          contact1: parseContact(s.contact1),
          contact2: parseContact(s.contact2),
          reason: s.reason,
        })),
      });
    } catch (err) {
      console.error('Failed to load suggestions:', err);
    }
  },

  selectContact: (id) => set({ selectedId: id }),

  updateContact: async (id, data) => {
    try {
      const updated = await api.updateContact(id, data);
      const parsed = parseContact(updated);
      set((state) => ({
        contacts: state.contacts.map((c) => (c.id === id ? parsed : c)),
      }));
    } catch (err) {
      console.error('Failed to update contact:', err);
    }
  },

  mergeContacts: async (targetId, sourceId) => {
    try {
      await api.mergeContacts(targetId, sourceId);
      await get().loadContacts();
      await get().loadSuggestions();
      const { selectedId } = get();
      if (selectedId === sourceId) set({ selectedId: targetId });
    } catch (err) {
      console.error('Failed to merge contacts:', err);
    }
  },

  deleteContact: async (id) => {
    try {
      await api.deleteContact(id);
      set((state) => ({
        contacts: state.contacts.filter((c) => c.id !== id),
        total: state.total - 1,
        selectedId: state.selectedId === id ? null : state.selectedId,
      }));
    } catch (err) {
      console.error('Failed to delete contact:', err);
    }
  },

  dismissSuggestion: async (contactId1, contactId2) => {
    try {
      await api.dismissSuggestion(contactId1, contactId2);
      set((state) => ({
        suggestions: state.suggestions.filter(
          (s) =>
            !(
              (s.contact1.id === contactId1 && s.contact2.id === contactId2) ||
              (s.contact1.id === contactId2 && s.contact2.id === contactId1)
            ),
        ),
      }));
    } catch (err) {
      console.error('Failed to dismiss suggestion:', err);
    }
  },

  undismissSuggestion: async (contactId1, contactId2) => {
    try {
      await api.undismissSuggestion(contactId1, contactId2);
      // Don't re-fetch — the MergeTinder component handles reinserting
      // the suggestion from its local undo stack
    } catch (err) {
      console.error('Failed to undismiss suggestion:', err);
    }
  },

  reinsertSuggestion: (suggestion) => {
    set((state) => ({
      suggestions: [suggestion, ...state.suggestions],
    }));
  },

  removeIdentifier: async (contactId, identifierId) => {
    try {
      const updated = await api.removeIdentifier(contactId, identifierId);
      const parsed = parseContact(updated);
      set((state) => ({
        contacts: state.contacts.map((c) => (c.id === contactId ? parsed : c)),
      }));
    } catch (err) {
      console.error('Failed to remove identifier:', err);
    }
  },

  splitContact: async (contactId, identifierIds) => {
    try {
      await api.splitContact(contactId, identifierIds);
      await get().loadContacts();
    } catch (err) {
      console.error('Failed to split contact:', err);
    }
  },
}));
