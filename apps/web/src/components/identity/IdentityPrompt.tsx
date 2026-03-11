import { useEffect, useState, useCallback, useRef } from 'react';
import { Modal } from '../ui/Modal';
import { Skeleton } from '../ui/Skeleton';
import { api } from '../../lib/api';

interface ContactOption {
  id: string;
  displayName: string;
  avatars?: string | Array<{ url: string; source: string }>;
  identifiers?: Array<{
    identifierType?: string;
    identifierValue?: string;
    type?: string;
    value?: string;
    [key: string]: unknown;
  }>;
}

interface MergeCandidate extends ContactOption {
  reason: string;
}

const POLL_INTERVAL = 10_000;

export function IdentityPrompt() {
  // "Who are you?" flow
  const [showIdentityPicker, setShowIdentityPicker] = useState(false);
  const [contacts, setContacts] = useState<ContactOption[]>([]);
  const [search, setSearch] = useState('');
  const identityDismissed = useRef(false);

  // Merge flow
  const [mergeCandidate, setMergeCandidate] = useState<MergeCandidate | null>(null);
  const [merging, setMerging] = useState(false);
  const dismissedMerges = useRef(new Set<string>());

  const [loading, setLoading] = useState(false);

  const checkStatus = useCallback(async () => {
    try {
      const { isSet } = await api.getMeStatus();

      if (!isSet) {
        // "Me" not set — show identity picker if not dismissed
        if (identityDismissed.current) return;
        const result = await api.listContacts({ limit: 50, entityType: 'person' });
        if (result.items.length > 0) {
          setContacts(result.items);
          setShowIdentityPicker(true);
        }
        return;
      }

      // "Me" is set — check for merge candidates
      if (mergeCandidate) return; // already showing one
      const candidates = await api.getMeMergeCandidates();
      const next = candidates.find((c) => !dismissedMerges.current.has(c.id));
      if (next) {
        setMergeCandidate(next);
      }
    } catch {
      // API not ready
    }
  }, [mergeCandidate]);

  useEffect(() => {
    checkStatus();
    const interval = setInterval(checkStatus, POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [checkStatus]);

  /* ---- Identity picker handlers ---- */

  const handleSelectIdentity = async (contactId: string) => {
    setLoading(true);
    try {
      await api.setMe(contactId);
      setShowIdentityPicker(false);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  };

  const handleDismissIdentity = () => {
    identityDismissed.current = true;
    setShowIdentityPicker(false);
  };

  /* ---- Merge handlers ---- */

  const handleMerge = async () => {
    if (!mergeCandidate) return;
    setMerging(true);
    try {
      const { contactId } = await api.getMeStatus();
      if (contactId) {
        await api.mergeContacts(contactId, mergeCandidate.id);
      }
    } catch {
      // ignore
    } finally {
      setMerging(false);
      setMergeCandidate(null);
    }
  };

  const handleDismissMerge = async () => {
    if (!mergeCandidate) return;
    dismissedMerges.current.add(mergeCandidate.id);
    try {
      const { contactId } = await api.getMeStatus();
      if (contactId) {
        await api.dismissSuggestion(contactId, mergeCandidate.id);
      }
    } catch {
      // ignore
    }
    setMergeCandidate(null);
  };

  /* ---- Render: Identity picker ---- */

  const filtered = contacts.filter((c) => {
    if (!search) return true;
    const q = search.toLowerCase();
    if (c.displayName.toLowerCase().includes(q)) return true;
    return c.identifiers?.some((i) =>
      (i.identifierValue || i.value || '').toLowerCase().includes(q),
    );
  });

  if (showIdentityPicker) {
    return (
      <Modal open onClose={handleDismissIdentity} title="WHO ARE YOU?">
        <p className="font-mono text-sm text-nb-muted mb-4">
          Select your contact so botmem can personalize your experience.
        </p>

        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search contacts..."
          className="w-full border-3 border-nb-border bg-nb-surface font-mono text-sm text-nb-text px-4 py-3 mb-4 shadow-nb placeholder:text-nb-muted"
        />

        <div className="max-h-80 overflow-y-auto flex flex-col gap-1">
          {loading && <Skeleton variant="avatar" count={3} className="mb-2" />}
          {!loading && filtered.length === 0 && (
            <p className="font-mono text-sm text-nb-muted text-center py-4">No contacts found</p>
          )}
          {!loading &&
            filtered.map((c) => (
              <ContactRow key={c.id} contact={c} onClick={() => handleSelectIdentity(c.id)} />
            ))}
        </div>

        <button
          onClick={handleDismissIdentity}
          className="mt-4 w-full font-mono text-xs text-nb-muted hover:text-nb-text py-2 cursor-pointer transition-colors"
        >
          SKIP FOR NOW
        </button>
      </Modal>
    );
  }

  /* ---- Render: Merge prompt ---- */

  if (mergeCandidate) {
    const avatar = parseAvatarUrl(mergeCandidate.avatars);
    const emailIdent = mergeCandidate.identifiers?.find(
      (i) => (i.identifierType || i.type) === 'email',
    );
    const phoneIdent = mergeCandidate.identifiers?.find(
      (i) => (i.identifierType || i.type) === 'phone',
    );
    const email = emailIdent?.identifierValue || emailIdent?.value;
    const phone = phoneIdent?.identifierValue || phoneIdent?.value;

    return (
      <Modal open onClose={handleDismissMerge} title="IS THIS YOU?">
        <p className="font-mono text-sm text-nb-muted mb-4">
          A new contact was found that looks like it might be you.
        </p>

        <div className="border-3 border-nb-border p-4 mb-4 flex items-center gap-4">
          {avatar ? (
            <img
              src={avatar}
              alt=""
              className="size-14 border-2 border-nb-border object-cover shrink-0"
            />
          ) : (
            <div className="size-14 border-2 border-nb-border bg-nb-surface-muted flex items-center justify-center shrink-0">
              <span className="font-display text-xl font-bold text-nb-muted">
                {mergeCandidate.displayName[0]?.toUpperCase()}
              </span>
            </div>
          )}
          <div className="flex-1 min-w-0">
            <p className="font-display text-lg font-bold uppercase truncate text-nb-text">
              {mergeCandidate.displayName}
            </p>
            <p className="font-mono text-xs text-nb-muted truncate">{email ?? phone ?? '--'}</p>
            <p className="font-mono text-[10px] text-nb-lime mt-1">{mergeCandidate.reason}</p>
          </div>
        </div>

        <div className="flex gap-3">
          <button
            onClick={handleMerge}
            disabled={merging}
            className="flex-1 border-3 border-nb-border bg-nb-lime text-black font-display text-sm font-bold uppercase py-3 hover:brightness-90 transition-all cursor-pointer disabled:opacity-50"
          >
            {merging ? 'MERGING...' : 'YES, MERGE'}
          </button>
          <button
            onClick={handleDismissMerge}
            className="flex-1 border-3 border-nb-border bg-nb-surface text-nb-text font-display text-sm font-bold uppercase py-3 hover:bg-nb-surface-hover transition-colors cursor-pointer"
          >
            NOT ME
          </button>
        </div>
      </Modal>
    );
  }

  return null;
}

/* ---- Shared contact row ---- */

function parseAvatarUrl(
  avatars: string | Array<{ url: string; source: string }> | undefined,
): string | null {
  if (!avatars) return null;
  if (Array.isArray(avatars)) return avatars[0]?.url ?? null;
  try {
    const parsed = JSON.parse(avatars);
    return parsed[0]?.url ?? null;
  } catch {
    return null;
  }
}

function ContactRow({ contact, onClick }: { contact: ContactOption; onClick: () => void }) {
  const avatar = parseAvatarUrl(contact.avatars);
  const email = contact.identifiers?.find((i) => (i.identifierType || i.type) === 'email');
  const phone = contact.identifiers?.find((i) => (i.identifierType || i.type) === 'phone');

  return (
    <button
      onClick={onClick}
      className="flex items-center gap-3 border-2 border-nb-border p-3 hover:bg-nb-lime hover:text-black transition-colors cursor-pointer text-left w-full"
    >
      {avatar ? (
        <img
          src={avatar}
          alt=""
          className="size-10 border-2 border-nb-border object-cover shrink-0"
        />
      ) : (
        <div className="size-10 border-2 border-nb-border bg-nb-surface-muted flex items-center justify-center shrink-0">
          <span className="font-display font-bold text-nb-muted">
            {contact.displayName[0]?.toUpperCase()}
          </span>
        </div>
      )}
      <div className="flex-1 min-w-0">
        <p className="font-display text-sm font-bold uppercase truncate">{contact.displayName}</p>
        <p className="font-mono text-[10px] text-nb-muted truncate">
          {(email?.identifierValue || email?.value) ??
            (phone?.identifierValue || phone?.value) ??
            '--'}
        </p>
      </div>
    </button>
  );
}
