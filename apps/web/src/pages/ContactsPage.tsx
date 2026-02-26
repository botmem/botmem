import { useEffect, useState } from 'react';
import { PageContainer } from '../components/layout/PageContainer';
import { Card } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { ContactCard } from '../components/contacts/ContactCard';
import { ContactDetailPanel } from '../components/contacts/ContactDetailPanel';
import { MergeSuggestionRow } from '../components/contacts/MergeSuggestionRow';
import { useContactStore } from '../store/contactStore';

export function ContactsPage() {
  const {
    contacts, total, suggestions, selectedId, searchQuery, loading,
    loadContacts, setSearchQuery, loadSuggestions, selectContact,
    updateContact, mergeContacts, deleteContact, dismissSuggestion,
  } = useContactStore();

  const [suggestionsOpen, setSuggestionsOpen] = useState(true);

  useEffect(() => {
    loadContacts();
    loadSuggestions();
  }, []);

  const selectedContact = contacts.find((c) => c.id === selectedId) || null;

  return (
    <PageContainer>
      <h1 className="font-display text-3xl font-bold uppercase tracking-wider text-nb-text mb-6">
        CONTACTS
      </h1>

      {/* Merge suggestions */}
      {suggestions.length > 0 && (
        <Card className="mb-4">
          <button
            onClick={() => setSuggestionsOpen(!suggestionsOpen)}
            className="flex items-center gap-2 w-full cursor-pointer"
          >
            <h2 className="font-display text-lg font-bold uppercase tracking-wider text-nb-text">
              SUGGESTED MERGES
            </h2>
            <Badge color="#FFE66D">{suggestions.length}</Badge>
            <span className="font-mono text-sm text-nb-muted ml-auto">
              {suggestionsOpen ? '▼' : '▶'}
            </span>
          </button>

          {suggestionsOpen && (
            <div className="flex flex-col gap-3 mt-4">
              {suggestions.map((s) => (
                <MergeSuggestionRow
                  key={`${s.contact1.id}::${s.contact2.id}`}
                  contact1={s.contact1}
                  contact2={s.contact2}
                  reason={s.reason}
                  onMerge={mergeContacts}
                  onDismiss={dismissSuggestion}
                />
              ))}
            </div>
          )}
        </Card>
      )}

      {/* Search */}
      <input
        type="text"
        value={searchQuery}
        onChange={(e) => setSearchQuery(e.target.value)}
        placeholder="Search contacts..."
        className="w-full border-3 border-nb-border bg-nb-surface font-mono text-sm text-nb-text px-4 py-3 mb-4 shadow-nb placeholder:text-nb-muted"
      />

      <p className="font-mono text-xs text-nb-muted uppercase mb-3">
        {loading ? 'LOADING...' : `${total} contacts`}
      </p>

      <div className="flex gap-4">
        {/* Contact list */}
        <div className="flex-1 flex flex-col gap-2">
          {contacts.map((c) => (
            <ContactCard
              key={c.id}
              contact={c}
              selected={selectedId === c.id}
              onClick={() => selectContact(selectedId === c.id ? null : c.id)}
            />
          ))}
          {contacts.length === 0 && !loading && (
            <div className="border-3 border-nb-border p-8 text-center bg-nb-surface">
              <p className="font-display text-xl font-bold uppercase text-nb-text">NO CONTACTS FOUND</p>
              <p className="font-mono text-sm text-nb-muted mt-2">TRY ADJUSTING YOUR SEARCH</p>
            </div>
          )}
        </div>

        {/* Detail panel */}
        {selectedContact && (
          <div className="w-96 shrink-0">
            <ContactDetailPanel
              contact={selectedContact}
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
