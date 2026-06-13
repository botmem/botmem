import { create } from 'zustand';
import { api } from '../lib/api';
import { trackEvent } from '../lib/posthog';
import type { ApiContact } from '../lib/api';
import { dedupeIdentifiers } from '../components/contacts/identifiers';

interface Contact {
  id: string;
  displayName: string;
  entityType: string;
  avatars: Array<{ url: string; source: string }>;
  avatarUrl?: string;
  hasAvatar: boolean;
  identifiers: Array<{ id: string; type: string; value: string; isPrimary: boolean }>;
  connectorSources: string[];
  members?: Array<{
    id: string;
    displayName: string;
    avatars: Array<{ url: string; source: string }>;
    identifiers?: Array<{ type: string; value: string }>;
  }>;
  memoryCount: number;
  createdAt: string;
  updatedAt: string;
}

interface MergeSuggestion {
  contact1: Contact;
  contact2: Contact;
  reason: string;
  confidence?: number;
  positiveEvidence?: string[];
  negativeEvidence?: string[];
  sharedIdentifiers?: string[];
  aliasSimilarity?: number;
  cooccurrenceConflicts?: string[];
  sourceConnectors?: string[];
  sampleMemoryIds?: string[];
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

function parseAvatars(rawAvatars: ApiContact['avatars']): Array<{ url: string; source: string }> {
  if (Array.isArray(rawAvatars)) return rawAvatars;
  if (typeof rawAvatars !== 'string' || !rawAvatars.trim()) return [];
  try {
    const parsed = JSON.parse(rawAvatars);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseContact(raw: ApiContact): Contact {
  const avatars = parseAvatars(raw.avatars);
  const identifiers = dedupeIdentifiers(
    (raw.identifiers || []).map((i) => ({
      id: i.id,
      type: i.identifierType || i.type || '',
      value: i.identifierValue || i.value || '',
      isPrimary: i.isPrimary || false,
    })),
  );
  const connectorSources = [
    ...new Set((raw.identifiers || []).map((i) => i.connectorType).filter(Boolean)),
  ] as string[];

  return {
    id: raw.id,
    displayName: raw.displayName || '',
    entityType: raw.entityType || 'person',
    avatars,
    avatarUrl: raw.avatarUrl,
    hasAvatar: raw.hasAvatar ?? avatars.length > 0,
    identifiers,
    connectorSources,
    members: Array.isArray(raw.members)
      ? raw.members.map((member) => ({
          id: member.id,
          displayName: member.displayName,
          avatars: parseAvatars(member.avatars),
          identifiers: (member.identifiers || []).map((ident) => ({
            type: ident.identifierType || ident.type || '',
            value: ident.identifierValue || ident.value || '',
          })),
        }))
      : undefined,
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
      const filter = get().entityFilter;
      const results = await api.searchContacts(query, filter);
      const contacts = results.map(parseContact).filter((contact) => contact.entityType === filter);
      trackEvent('contact_search', { query_length: query.length, result_count: contacts.length });
      set({ contacts, total: contacts.length, loading: false });
    } catch (err) {
      console.error('Failed to search contacts:', err);
      set({ loading: false });
    }
  },

  setEntityFilter: (filter) => {
    set({ entityFilter: filter, selectedId: null });
    const query = get().searchQuery.trim();
    if (query.length >= 3) get().searchContacts(query);
    else get().loadContacts(filter);
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
          confidence: s.confidence,
          positiveEvidence: s.positiveEvidence,
          negativeEvidence: s.negativeEvidence,
          sharedIdentifiers: s.sharedIdentifiers,
          aliasSimilarity: s.aliasSimilarity,
          cooccurrenceConflicts: s.cooccurrenceConflicts,
          sourceConnectors: s.sourceConnectors,
          sampleMemoryIds: s.sampleMemoryIds,
        })),
      });

      const { contacts, total, searchQuery, entityFilter } = get();
      if (contacts.length > 0 || total > 0) {
        if (searchQuery.trim().length >= 3) {
          await get().searchContacts(searchQuery);
        } else {
          await get().loadContacts(entityFilter);
        }
      }
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
    trackEvent('contact_merge');
    // Optimistic update: remove source from contacts list and suggestion from suggestions
    set((state) => ({
      contacts: state.contacts.filter((c) => c.id !== sourceId),
      total: Math.max(0, state.total - 1),
      suggestions: state.suggestions.filter(
        (s) =>
          !(
            (s.contact1.id === sourceId || s.contact2.id === sourceId) &&
            (s.contact1.id === targetId || s.contact2.id === targetId)
          ),
      ),
      selectedId: state.selectedId === sourceId ? targetId : state.selectedId,
    }));
    try {
      const merged = await api.mergeContacts(targetId, sourceId);
      const parsed = parseContact(merged as ApiContact);
      set((state) => ({
        contacts: state.contacts.map((contact) => (contact.id === targetId ? parsed : contact)),
      }));
    } catch (err) {
      console.error('Failed to merge contacts:', err);
      // Reload on failure to restore correct state
      get().loadContacts();
      get().loadSuggestions();
    }
  },

  deleteContact: async (id) => {
    try {
      await api.deleteContact(id);
      trackEvent('contact_deleted');
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
      trackEvent('contact_split', { identifier_count: identifierIds.length });
      await get().loadContacts();
    } catch (err) {
      console.error('Failed to split contact:', err);
    }
  },
}));
