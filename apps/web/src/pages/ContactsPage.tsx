import { useEffect, useState, useMemo, useRef } from 'react';
import { PageContainer } from '../components/layout/PageContainer';
import { ContactCard } from '../components/contacts/ContactCard';
import { ContactDetailPanel } from '../components/contacts/ContactDetailPanel';
import { MergeTinder } from '../components/contacts/MergeTinder';
import { useContactStore } from '../store/contactStore';
import { EmptyState } from '../components/ui/EmptyState';
import { Skeleton } from '../components/ui/Skeleton';
import { api } from '../lib/api';

export function ContactsPage() {
  const {
    contacts, total, suggestions, selectedId, searchQuery, loading,
    loadContacts, setSearchQuery, loadSuggestions, selectContact,
    updateContact, mergeContacts, deleteContact, dismissSuggestion, undismissSuggestion, reinsertSuggestion,
  } = useContactStore();

  const [selfContactId, setSelfContactId] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(50);
  const sentinelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    loadContacts();
    loadSuggestions();
    api.getMeStatus().then(({ contactId }) => setSelfContactId(contactId)).catch(() => {});
  }, []);

  const selectedContact = contacts.find((c) => c.id === selectedId) || null;

  useEffect(() => {
    setVisibleCount(50);
  }, [searchQuery]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && visibleCount < contacts.length) {
          setVisibleCount((prev) => Math.min(prev + 50, contacts.length));
        }
      },
      { threshold: 0.1 }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [visibleCount, contacts.length]);

  const filteredSuggestions = useMemo(() => {
    if (!searchQuery.trim()) return suggestions;
    const term = searchQuery.toLowerCase();
    return suggestions.filter((s) =>
      s.contact1.displayName.toLowerCase().includes(term) ||
      s.contact2.displayName.toLowerCase().includes(term) ||
      s.contact1.identifiers.some((i) => i.value.toLowerCase().includes(term)) ||
      s.contact2.identifiers.some((i) => i.value.toLowerCase().includes(term))
    );
  }, [suggestions, searchQuery]);

  return (
    <PageContainer>
      <h1 className="font-display text-3xl font-bold uppercase tracking-wider text-nb-text mb-6">
        PEOPLE
      </h1>

      {/* Search */}
      <input
        type="text"
        value={searchQuery}
        onChange={(e) => setSearchQuery(e.target.value)}
        placeholder="Search people..."
        className="w-full border-3 border-nb-border bg-nb-surface font-mono text-sm text-nb-text px-4 py-3 mb-4 shadow-nb placeholder:text-nb-muted"
      />

      {/* Merge suggestions — Tinder-style card review */}
      <MergeTinder
        suggestions={filteredSuggestions}
        onMerge={mergeContacts}
        onDismiss={dismissSuggestion}
        onUndismiss={undismissSuggestion}
        onReinsertSuggestion={reinsertSuggestion}
      />

      <p className="font-mono text-xs text-nb-muted uppercase mb-3">
        {loading ? 'LOADING...' : `${total} people`}
      </p>

      <div className="flex gap-4">
        {/* Contact list */}
        <div className="flex-1 flex flex-col gap-2 overflow-y-auto" style={{ maxHeight: 'calc(100vh - 16rem)' }}>
          {loading && <Skeleton variant="avatar" count={5} className="mb-2" />}
          {!loading && contacts.slice(0, visibleCount).map((c) => (
            <ContactCard
              key={c.id}
              contact={c}
              selected={selectedId === c.id}
              isSelf={selfContactId === c.id}
              onClick={() => selectContact(selectedId === c.id ? null : c.id)}
            />
          ))}
          {!loading && visibleCount < contacts.length && (
            <div ref={sentinelRef} className="py-4 text-center">
              <span className="font-mono text-xs text-nb-muted uppercase">Loading more...</span>
            </div>
          )}
          {contacts.length === 0 && !loading && (
            <EmptyState
              icon="◎"
              title="No People Found"
              subtitle="Try adjusting your search"
            />
          )}
        </div>

        {/* Detail panel */}
        {selectedContact && (
          <div className="w-96 shrink-0">
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
    </PageContainer>
  );
}
