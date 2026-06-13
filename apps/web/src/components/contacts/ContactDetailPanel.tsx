import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { formatDate, getConnectorColor } from '@botmem/shared';
import { Card } from '../ui/Card';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Avatar } from '../ui/Avatar';
import { api } from '../../lib/api';
import { IDENTIFIER_COLORS } from './constants';
import { useContactStore } from '../../store/contactStore';
import { dedupeIdentifiers } from './identifiers';

const SELF_COLOR = 'var(--color-nb-lime)';
type DetailMember = {
  id: string;
  displayName: string;
  avatars: Array<{ url: string; source: string }>;
  identifiers?: Array<{ type: string; value: string }>;
};

function parseAvatars(raw: unknown): Array<{ url: string; source: string }> {
  if (Array.isArray(raw)) return raw as Array<{ url: string; source: string }>;
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeMembers(
  members: Array<{
    id: string;
    displayName: string;
    avatars?: unknown;
    identifiers?: Array<{
      identifierType?: string;
      type?: string;
      identifierValue?: string;
      value?: string;
    }>;
  }> = [],
): DetailMember[] {
  return members.map((member) => ({
    id: member.id,
    displayName: member.displayName,
    avatars: parseAvatars(member.avatars),
    identifiers: (member.identifiers || []).map((ident) => ({
      type: ident.identifierType || ident.type || '',
      value: ident.identifierValue || ident.value || '',
    })),
  }));
}

function isGroupLikeContact(contact: ContactDetailPanelProps['contact']): boolean {
  if (contact.entityType === 'group') return true;
  const normalizedName = contact.displayName.trim().toLowerCase();
  if (
    /^(dm|chat|group|conversation)\s+(with|for)\b/.test(normalizedName) ||
    /\b(group chat|whatsapp group|slack channel|telegram group)\b/.test(normalizedName) ||
    /[/|;&+<>]/.test(contact.displayName)
  ) {
    return true;
  }
  return contact.identifiers.some((ident) => {
    const digits = ident.value.replace(/\D/g, '');
    return (
      ident.type === 'whatsapp_group_jid' ||
      (ident.type === 'phone' && digits.startsWith('120363') && digits.length >= 15)
    );
  });
}

interface ContactDetailPanelProps {
  contact: {
    id: string;
    displayName: string;
    avatars: Array<{ url: string; source: string }>;
    identifiers: Array<{ id: string; type: string; value: string; isPrimary: boolean }>;
    connectorSources: string[];
    entityType?: string;
    members?: DetailMember[];
  };
  isSelf?: boolean;
  onClose: () => void;
  onUpdate: (id: string, data: { displayName?: string }) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}

export function ContactDetailPanel({
  contact,
  isSelf,
  onClose,
  onUpdate,
  onDelete,
}: ContactDetailPanelProps) {
  const [editName, setEditName] = useState(contact.displayName);
  const [memories, setMemories] = useState<
    Array<{
      id: string;
      eventTime?: string;
      createdAt?: string;
      connectorType?: string;
      text?: string;
    }>
  >([]);
  const [memoryTotal, setMemoryTotal] = useState(0);
  const [memoryPage, setMemoryPage] = useState(0);
  const [members, setMembers] = useState<DetailMember[]>(contact.members || []);
  const [copiedIdentId, setCopiedIdentId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [splitIds, setSplitIds] = useState<Set<string>>(new Set());
  const [showMergeSearch, setShowMergeSearch] = useState(false);
  const [mergeSearch, setMergeSearch] = useState('');
  const [mergeResults, setMergeResults] = useState<Array<{ id: string; displayName: string }>>([]);
  const mergeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const {
    removeIdentifier,
    splitContact,
    mergeContacts,
    contacts: allContacts,
  } = useContactStore();
  const groupLike = isGroupLikeContact(contact);
  const pageSize = 10;
  const identifiers = dedupeIdentifiers(contact.identifiers);

  useEffect(() => {
    setEditName(contact.displayName);
    setConfirmDelete(false);
    setSplitIds(new Set());
    setShowMergeSearch(false);
    setMergeSearch('');
    setMemoryPage(0);
    setMembers(contact.members || []);
    if (isGroupLikeContact(contact)) {
      api
        .getContact(contact.id)
        .then((detail) => setMembers(normalizeMembers(detail.members)))
        .catch(() => setMembers(contact.members || []));
    }
  }, [contact.id]);

  useEffect(() => {
    api
      .getContactMemories(contact.id, { limit: pageSize, offset: memoryPage * pageSize })
      .then((page) => {
        setMemories(page.items);
        setMemoryTotal(page.total);
      })
      .catch(() => {
        setMemories([]);
        setMemoryTotal(0);
      });
  }, [contact.id, memoryPage]);

  // Debounced search for merge target
  useEffect(() => {
    if (!mergeSearch.trim()) {
      setMergeResults([]);
      return;
    }
    if (mergeTimerRef.current) clearTimeout(mergeTimerRef.current);
    mergeTimerRef.current = setTimeout(() => {
      const term = mergeSearch.toLowerCase();
      const results = allContacts
        .filter(
          (c) =>
            c.id !== contact.id &&
            c.entityType === 'person' &&
            c.displayName.toLowerCase().includes(term),
        )
        .slice(0, 6);
      setMergeResults(results);
    }, 150);
  }, [mergeSearch, allContacts, contact.id]);

  const handleNameSave = () => {
    if (editName.trim() && editName !== contact.displayName) {
      onUpdate(contact.id, { displayName: editName.trim() });
    }
  };

  const handleDelete = () => {
    if (confirmDelete) {
      onDelete(contact.id);
    } else {
      setConfirmDelete(true);
    }
  };

  const handleMergeInto = async (sourceId: string) => {
    // Merge the selected person INTO the current contact (current = target, selected = source that gets absorbed)
    await mergeContacts(contact.id, sourceId);
    setShowMergeSearch(false);
    setMergeSearch('');
  };

  const lidNames = new Map<string, string>();
  for (const person of [...allContacts, ...members]) {
    const contactIdentifiers = person.identifiers || [];
    for (const ident of contactIdentifiers) {
      if (ident.type === 'whatsapp_lid') {
        lidNames.set(ident.value.replace(/@lid$/, ''), person.displayName);
      }
    }
  }
  const previewText = (text = '') =>
    text.replace(/@([a-z0-9._-]+)(?:@lid)?\b/gi, (match, lid) => {
      if (!/^\d{6,}$/.test(lid)) return match;
      return lidNames.has(lid) ? `@${lidNames.get(lid)}` : '@someone';
    });

  const copyIdentifier = async (ident: { id: string; value: string }) => {
    await navigator.clipboard?.writeText(ident.value);
    setCopiedIdentId(ident.id);
    setTimeout(() => setCopiedIdentId(null), 1200);
  };

  return (
    <Card
      className="sticky top-6"
      style={
        isSelf ? { borderColor: SELF_COLOR, boxShadow: `0 0 12px ${SELF_COLOR}40` } : undefined
      }
    >
      <div className="flex items-center justify-between mb-4">
        <h3
          className="font-display text-lg font-bold uppercase"
          style={isSelf ? { color: SELF_COLOR } : undefined}
        >
          {isSelf
            ? 'You'
            : groupLike
              ? 'Group Detail'
              : contact.entityType === 'device'
                ? 'Device Detail'
                : contact.entityType === 'organization'
                  ? 'Organization Detail'
                  : 'Person Detail'}
        </h3>
        <button
          onClick={onClose}
          className="border-2 border-nb-border size-8 flex items-center justify-center font-bold hover:bg-nb-red hover:text-white cursor-pointer text-nb-text"
        >
          X
        </button>
      </div>

      <div className="flex flex-col gap-4">
        {/* Avatar */}
        <div className="flex gap-2 flex-wrap">
          <Avatar
            contactId={contact.avatars?.length > 0 ? contact.id : undefined}
            fallbackInitials={contact.displayName.slice(0, 2).toUpperCase()}
            isSelf={isSelf}
            size="lg"
          />
        </div>

        {/* Editable name */}
        <div>
          <label
            htmlFor="contact-display-name"
            className="font-display text-xs font-bold uppercase tracking-wider text-nb-muted"
          >
            Display Name
          </label>
          <input
            id="contact-display-name"
            name="contact-display-name"
            type="text"
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            onBlur={handleNameSave}
            onKeyDown={(e) => e.key === 'Enter' && handleNameSave()}
            className="mt-1 w-full border-3 border-nb-border bg-nb-surface font-mono text-sm text-nb-text px-3 py-2"
          />
        </div>

        {/* Identifiers */}
        <div>
          <h4 className="font-display text-xs font-bold uppercase mb-2 text-nb-text">
            Identifiers
          </h4>
          <div className="flex flex-col gap-1.5">
            {identifiers.map((ident) => (
              <div key={ident.id} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={splitIds.has(ident.id)}
                  onChange={(e) => {
                    const next = new Set(splitIds);
                    if (e.target.checked) {
                      next.add(ident.id);
                    } else {
                      next.delete(ident.id);
                    }
                    setSplitIds(next);
                  }}
                  className="accent-nb-lime shrink-0"
                />
                <Badge color={IDENTIFIER_COLORS[ident.type]} className="text-[11px] py-0 shrink-0">
                  {ident.type}
                </Badge>
                <button
                  type="button"
                  onClick={() => copyIdentifier(ident)}
                  title={ident.value}
                  className="font-mono text-xs text-nb-text truncate flex-1 text-left hover:underline"
                >
                  {ident.value}
                </button>
                {copiedIdentId === ident.id && (
                  <span className="font-mono text-[10px] uppercase text-nb-lime">Copied</span>
                )}
                <button
                  onClick={() => removeIdentifier(contact.id, ident.id)}
                  disabled={identifiers.length <= 1}
                  className="border border-nb-border size-5 flex items-center justify-center text-[11px] font-bold hover:bg-nb-red hover:text-white cursor-pointer text-nb-muted disabled:opacity-30 disabled:cursor-not-allowed shrink-0"
                >
                  X
                </button>
              </div>
            ))}
            {splitIds.size > 0 && splitIds.size < identifiers.length && (
              <button
                onClick={async () => {
                  await splitContact(contact.id, Array.from(splitIds));
                  setSplitIds(new Set());
                }}
                className="mt-2 w-full border-2 border-nb-border px-3 py-1.5 font-mono text-xs font-bold uppercase bg-nb-surface text-nb-text hover:bg-nb-lime hover:text-black cursor-pointer transition-colors"
              >
                SPLIT SELECTED ({splitIds.size})
              </button>
            )}
          </div>
        </div>

        {/* Merge another person into this one */}
        {!groupLike && (
          <div>
            <button
              onClick={() => {
                setShowMergeSearch(!showMergeSearch);
                setMergeSearch('');
              }}
              className="w-full border-2 border-nb-border px-3 py-1.5 font-mono text-xs font-bold uppercase bg-nb-surface text-nb-text hover:bg-nb-lime hover:text-black cursor-pointer transition-colors flex items-center justify-center gap-2"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 14 14"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M7 1v12M1 7h12" />
              </svg>
              Merge another person into this one
            </button>
            {showMergeSearch && (
              <div className="mt-2 border-2 border-nb-border bg-nb-surface-muted p-2">
                <input
                  type="text"
                  id="merge-contact-search"
                  name="merge-contact-search"
                  value={mergeSearch}
                  onChange={(e) => setMergeSearch(e.target.value)}
                  placeholder="Search person to absorb..."
                  className="w-full border-2 border-nb-border bg-nb-surface font-mono text-xs text-nb-text px-2 py-1.5 placeholder:text-nb-muted"
                />
                {mergeResults.length > 0 && (
                  <div className="mt-1 flex flex-col gap-0.5">
                    {mergeResults.map((r) => (
                      <button
                        key={r.id}
                        onClick={() => handleMergeInto(r.id)}
                        className="text-left px-2 py-1.5 border border-nb-border font-mono text-xs text-nb-text hover:bg-nb-red hover:text-white cursor-pointer transition-colors flex items-center gap-2"
                      >
                        <svg
                          width="12"
                          height="12"
                          viewBox="0 0 12 12"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.5"
                        >
                          <path d="M9 3L3 6l6 3" />
                          <line x1="10" y1="6" x2="3" y2="6" />
                        </svg>
                        <span className="truncate">{r.displayName}</span>
                        <span className="font-mono text-[9px] text-nb-muted ml-auto shrink-0">
                          merge in
                        </span>
                      </button>
                    ))}
                  </div>
                )}
                {mergeSearch.trim() && mergeResults.length === 0 && (
                  <p className="font-mono text-[11px] text-nb-muted mt-1">No matches</p>
                )}
                <p className="font-mono text-[9px] text-nb-muted mt-1.5">
                  Their identifiers and memories will be absorbed into {contact.displayName}
                </p>
              </div>
            )}
          </div>
        )}

        {groupLike && (
          <div>
            <h4 className="font-display text-xs font-bold uppercase mb-2 text-nb-text">
              Members ({members.length})
            </h4>
            <div className="flex flex-col gap-1.5 max-h-40 overflow-y-auto">
              {members.length === 0 && (
                <p className="font-mono text-xs text-nb-muted">No resolved members</p>
              )}
              {members.map((member) => (
                <div
                  key={member.id}
                  className="flex items-center gap-2 border border-nb-border bg-nb-surface-muted p-1.5"
                >
                  <Avatar
                    contactId={member.avatars?.length > 0 ? member.id : undefined}
                    fallbackInitials={member.displayName.slice(0, 2).toUpperCase()}
                    size="sm"
                  />
                  <span className="font-mono text-xs text-nb-text truncate">
                    {member.displayName}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Linked memories */}
        <div>
          <h4 className="font-display text-xs font-bold uppercase mb-2 text-nb-text">
            Linked Memories ({memoryTotal})
          </h4>
          <div className="flex flex-col gap-1 max-h-60 overflow-y-auto">
            {memories.length === 0 && (
              <p className="font-mono text-xs text-nb-muted">No linked memories</p>
            )}
            {memories.map((m) => (
              <Link
                key={m.id}
                to={`/dashboard?memoryId=${encodeURIComponent(m.id)}`}
                className="border-2 border-nb-border p-2 bg-nb-surface-muted hover:bg-nb-surface-hover focus-visible:outline-2 focus-visible:outline-nb-lime"
              >
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="font-mono text-[11px] text-nb-muted">
                    {formatDate(m.eventTime || m.createdAt || '')}
                  </span>
                  <Badge
                    color={getConnectorColor(m.connectorType, undefined)}
                    className="text-[11px] py-0"
                  >
                    {m.connectorType}
                  </Badge>
                </div>
                <p className="font-mono text-xs text-nb-text line-clamp-2">
                  {previewText(m.text)}
                </p>
              </Link>
            ))}
          </div>
          {memoryTotal > pageSize && (
            <div className="mt-2 flex items-center justify-between gap-2">
              <button
                type="button"
                onClick={() => setMemoryPage((page) => Math.max(0, page - 1))}
                disabled={memoryPage === 0}
                className="border-2 border-nb-border px-2 py-1 font-mono text-[11px] font-bold uppercase text-nb-text disabled:opacity-30"
              >
                Prev
              </button>
              <span className="font-mono text-[11px] text-nb-muted">
                {memoryPage * pageSize + 1}-{Math.min(memoryTotal, (memoryPage + 1) * pageSize)} /{' '}
                {memoryTotal}
              </span>
              <button
                type="button"
                onClick={() => setMemoryPage((page) => page + 1)}
                disabled={(memoryPage + 1) * pageSize >= memoryTotal}
                className="border-2 border-nb-border px-2 py-1 font-mono text-[11px] font-bold uppercase text-nb-text disabled:opacity-30"
              >
                Next
              </button>
            </div>
          )}
        </div>

        {/* Delete */}
        <Button variant="danger" size="sm" onClick={handleDelete}>
          {confirmDelete
            ? 'CONFIRM DELETE'
            : `DELETE ${(contact.entityType || 'person').toUpperCase()}`}
        </Button>
      </div>
    </Card>
  );
}
