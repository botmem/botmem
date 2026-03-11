import { useEffect, useState, useMemo } from 'react';
import { PageContainer } from '../components/layout/PageContainer';
import { ContactCard } from '../components/contacts/ContactCard';
import { ContactDetailPanel } from '../components/contacts/ContactDetailPanel';
import { MergeTinder } from '../components/contacts/MergeTinder';
import { useContactStore } from '../store/contactStore';
import { EmptyState } from '../components/ui/EmptyState';
import { Skeleton } from '../components/ui/Skeleton';
import { InfiniteScrollList } from '../components/ui/InfiniteScrollList';
import { api } from '../lib/api';

export function ContactsPage() {
  const {
    contacts,
    total,
    suggestions,
    selectedId,
    searchQuery,
    loading,
    loadingMore,
    hasMore,
    entityFilter,
    loadContacts,
    loadMoreContacts,
    setSearchQuery,
    setEntityFilter,
    loadSuggestions,
    selectContact,
    updateContact,
    mergeContacts,
    deleteContact,
    dismissSuggestion,
    undismissSuggestion,
    reinsertSuggestion,
  } = useContactStore();

  const [selfContactId, setSelfContactId] = useState<string | null>(null);

  useEffect(() => {
    loadContacts();
    loadSuggestions();
    api
      .getMeStatus()
      .then(({ contactId }) => setSelfContactId(contactId))
      .catch(() => {});
  }, []);

  const selectedContact = contacts.find((c) => c.id === selectedId) || null;

  const filteredSuggestions = useMemo(() => {
    if (!searchQuery.trim()) return suggestions;
    const term = searchQuery.toLowerCase();
    return suggestions.filter(
      (s) =>
        s.contact1.displayName.toLowerCase().includes(term) ||
        s.contact2.displayName.toLowerCase().includes(term) ||
        s.contact1.identifiers.some((i) => i.value.toLowerCase().includes(term)) ||
        s.contact2.identifiers.some((i) => i.value.toLowerCase().includes(term)),
    );
  }, [suggestions, searchQuery]);

  return (
    <PageContainer>
      <h1 className="font-display text-3xl font-bold uppercase tracking-wider text-nb-text mb-4">
        CONTACTS
      </h1>

      {/* Entity type tabs */}
      <div className="flex gap-0 mb-4 border-3 border-nb-border w-fit">
        {(
          [
            ['person', 'PEOPLE'],
            ['group', 'GROUPS'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            onClick={() => setEntityFilter(value)}
            className={`font-mono text-xs font-bold uppercase px-4 py-2 cursor-pointer transition-colors ${
              entityFilter === value
                ? 'bg-nb-lime text-black'
                : 'bg-nb-surface text-nb-muted hover:text-nb-text'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Search */}
      <label htmlFor="contacts-search" className="sr-only">
        Search {entityFilter === 'group' ? 'groups' : 'people'}
      </label>
      <input
        id="contacts-search"
        type="text"
        value={searchQuery}
        onChange={(e) => setSearchQuery(e.target.value)}
        placeholder={`Search ${entityFilter === 'group' ? 'groups' : 'people'}...`}
        aria-label={`Search ${entityFilter === 'group' ? 'groups' : 'people'}`}
        className="w-full border-3 border-nb-border bg-nb-surface font-mono text-sm text-nb-text px-4 py-3 mb-4 shadow-nb placeholder:text-nb-muted"
      />

      {/* Merge suggestions — Tinder-style card review */}
      {filteredSuggestions.length > 0 && (
        <MergeTinder
          suggestions={filteredSuggestions}
          onMerge={mergeContacts}
          onDismiss={dismissSuggestion}
          onUndismiss={undismissSuggestion}
          onReinsertSuggestion={reinsertSuggestion}
        />
      )}

      <p className="font-mono text-xs text-nb-muted uppercase mb-3">
        {loading ? 'LOADING...' : `${total} ${entityFilter === 'group' ? 'groups' : 'people'}`}
      </p>

      <div className="flex flex-col md:flex-row gap-4" data-tour="people-grid">
        {/* Contact list */}
        <InfiniteScrollList
          items={contacts}
          renderItem={(c) => (
            <ContactCard
              contact={c}
              selected={selectedId === c.id}
              isSelf={selfContactId === c.id}
              onClick={() => selectContact(selectedId === c.id ? null : c.id)}
            />
          )}
          keyExtractor={(c) => c.id}
          hasMore={hasMore}
          loading={loading}
          loadingMore={loadingMore}
          onLoadMore={loadMoreContacts}
          disabled={!!searchQuery.trim()}
          className="flex-1 flex flex-col gap-2 overflow-y-auto"
          loadingSkeleton={<Skeleton variant="avatar" count={5} className="mb-2" />}
          emptyState={
            <EmptyState
              icon="\u25CE"
              title={entityFilter === 'group' ? 'No Groups Found' : 'No People Found'}
              subtitle="Try adjusting your search"
            />
          }
        />

        {/* Desktop detail panel */}
        {selectedContact && (
          <div className="hidden md:block md:w-96 md:shrink-0">
            <ContactDetailPanel
              contact={selectedContact}
              isSelf={selfContactId === selectedContact.id}
              onClose={() => selectContact(null)}
              onUpdate={updateContact}
              onDelete={deleteContact}
            />
          </div>
        )}

        {/* Mobile full-screen detail overlay */}
        <div
          className={`fixed inset-0 z-50 bg-nb-bg overflow-y-auto md:hidden ${selectedContact ? 'block' : 'hidden'}`}
        >
          <div className="p-4 border-b-4 border-nb-border flex items-center gap-3 bg-nb-surface">
            <button
              onClick={() => selectContact(null)}
              className="border-2 border-nb-border w-9 h-9 flex items-center justify-center hover:bg-nb-lime hover:text-black transition-colors cursor-pointer text-nb-text"
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M10 3L5 8l5 5" />
              </svg>
            </button>
            <span className="font-display text-sm font-bold uppercase tracking-wider text-nb-text">
              DETAIL
            </span>
          </div>
          {selectedContact && (
            <div className="p-4">
              <ContactDetailPanel
                contact={selectedContact}
                isSelf={selfContactId === selectedContact.id}
                onClose={() => selectContact(null)}
                onUpdate={updateContact}
                onDelete={deleteContact}
              />
            </div>
          )}
        </div>
      </div>
    </PageContainer>
  );
}
