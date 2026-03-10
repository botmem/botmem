import { useEffect, useState, useCallback } from 'react';
import { PageContainer } from '../components/layout/PageContainer';
import { Card } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Modal } from '../components/ui/Modal';
import { EmptyState } from '../components/ui/EmptyState';
import { Skeleton } from '../components/ui/Skeleton';
import { api } from '../lib/api';
import { Avatar } from '../components/ui/Avatar';

/* ---------- connector display config ---------- */

const CONNECTOR_META: Record<string, { icon: string; color: string; label: string }> = {
  gmail: { icon: '@', color: '#EF4444', label: 'Gmail' },
  slack: { icon: '#', color: '#4ECDC4', label: 'Slack' },
  whatsapp: { icon: 'W', color: '#22C55E', label: 'WhatsApp' },
  imessage: { icon: 'i', color: '#A855F7', label: 'iMessage' },
  'photos-immich': { icon: 'P', color: '#FF8A50', label: 'Photos' },
  owntracks: { icon: 'L', color: '#FFE66D', label: 'OwnTracks' },
};

function connectorMeta(type: string) {
  return CONNECTOR_META[type] ?? { icon: '?', color: '#888888', label: type };
}

const SOURCE_COLORS: Record<string, string> = {
  email: '#EF4444',
  message: '#4ECDC4',
  photo: '#FF8A50',
  location: '#FFE66D',
};

/* ---------- helper: truncate text ---------- */

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + '...';
}

/* ---------- helper: relative time ---------- */

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

/* ---------- helper: format date ---------- */

function formatDate(iso: string | null): string {
  if (!iso) return '--';
  return new Date(iso).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/* ---------- types ---------- */

interface MeData {
  identity: {
    name: string | null;
    email: string | null;
    phone: string | null;
    avatars: Array<{ url: string; source: string }>;
    preferredAvatarIndex: number;
    contactId: string | null;
  };
  accounts: Array<{
    id: string;
    connectorType: string;
    identifier: string;
    status: string;
    lastSyncAt: string | null;
    itemsSynced?: number;
    memoriesCount?: number;
  }>;
  stats: {
    totalMemories: number;
    totalContacts: number;
    memoriesByConnector: Record<string, number>;
    memoriesByType: Record<string, number>;
    oldestMemory: string | null;
    newestMemory: string | null;
  };
  topEntities: Array<{ name: string; count: number }>;
  recentMemories: Array<{
    id: string;
    connectorType: string;
    sourceType: string;
    text: string;
    eventTime: string;
  }>;
}

interface ContactOption {
  id: string;
  displayName: string;
  avatars: string;
  identifiers: Array<{ identifierType: string; identifierValue: string }>;
}

/* ========== COMPONENT ========== */

export function MePage() {
  const [data, setData] = useState<MeData | null>(null);
  const [loading, setLoading] = useState(true);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [contactOptions, setContactOptions] = useState<ContactOption[]>([]);
  const [contactSearch, setContactSearch] = useState('');
  const [contactsLoading, setContactsLoading] = useState(false);
  const [selectedAvatarIndex, setSelectedAvatarIndex] = useState(0);

  const fetchMe = useCallback(async () => {
    try {
      const result = await api.getMe();
      setData(result);
      setSelectedAvatarIndex(result?.identity?.preferredAvatarIndex ?? 0);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchMe();
  }, [fetchMe]);

  const openPicker = async () => {
    setPickerOpen(true);
    setContactsLoading(true);
    try {
      const result = await api.listContacts({ limit: 200 });
      setContactOptions(result.items);
    } catch {
      // ignore
    } finally {
      setContactsLoading(false);
    }
  };

  const selectIdentity = async (contactId: string) => {
    try {
      await api.setMe(contactId);
      setPickerOpen(false);
      setLoading(true);
      await fetchMe();
    } catch {
      // ignore
    }
  };

  /* ---------- loading state ---------- */

  if (loading) {
    return (
      <PageContainer>
        <Skeleton variant="card" count={3} />
      </PageContainer>
    );
  }

  /* ---------- not identified ---------- */

  const identified = data?.identity?.contactId;

  if (!identified) {
    return (
      <PageContainer>
        <div className="flex flex-col items-center justify-center py-20">
          <EmptyState
            icon="?"
            title="Who Are You?"
            subtitle="Select your contact to personalize this page"
          />
          <Button className="mt-6" onClick={openPicker}>
            SELECT MY IDENTITY
          </Button>
        </div>

        <ContactPickerModal
          open={pickerOpen}
          onClose={() => setPickerOpen(false)}
          contacts={contactOptions}
          loading={contactsLoading}
          search={contactSearch}
          onSearchChange={setContactSearch}
          onSelect={selectIdentity}
        />
      </PageContainer>
    );
  }

  /* ---------- identified — full page ---------- */

  const { identity, accounts: connectedAccounts, stats, topEntities, recentMemories } = data!;

  const selectedAvatar = identity.avatars?.[selectedAvatarIndex] ?? identity.avatars?.[0];

  const statCards = [
    { label: 'TOTAL MEMORIES', value: stats.totalMemories.toLocaleString(), color: '#C4F53A' },
    { label: 'TOTAL CONTACTS', value: stats.totalContacts.toLocaleString(), color: '#4ECDC4' },
    { label: 'OLDEST MEMORY', value: formatDate(stats.oldestMemory), color: '#FF6B9D' },
    { label: 'NEWEST MEMORY', value: formatDate(stats.newestMemory), color: '#FFE66D' },
  ];

  // Filter contacts for picker
  const filteredContacts = contactOptions.filter((c) => {
    if (!contactSearch) return true;
    const q = contactSearch.toLowerCase();
    if (c.displayName.toLowerCase().includes(q)) return true;
    return c.identifiers?.some((i) => i.identifierValue.toLowerCase().includes(q));
  });

  return (
    <PageContainer>
      {/* ---- HEADER ---- */}
      <Card className="p-0 overflow-hidden mb-6">
        <div className="bg-nb-lime h-2" />
        <div className="p-6 flex items-center gap-6">
          <Avatar
            contactId={identity.contactId ?? undefined}
            src={selectedAvatar?.url}
            fallbackInitials={(identity.name ?? '?')[0]?.toUpperCase() ?? '?'}
            isSelf
            size="lg"
            className="w-24 h-24 shrink-0"
          />

          <div className="flex-1 min-w-0">
            <h1 className="font-display text-3xl font-bold uppercase tracking-wider text-nb-text truncate">
              {identity.name ?? 'Unknown'}
            </h1>
            <div className="mt-2 flex flex-wrap gap-3">
              {identity.email && (
                <span className="font-mono text-sm text-nb-muted">{identity.email}</span>
              )}
              {identity.phone && (
                <span className="font-mono text-sm text-nb-muted">{identity.phone}</span>
              )}
            </div>
            {identity.avatars.length > 1 && (
              <div className="flex gap-2 mt-3 flex-wrap">
                {identity.avatars.map((a, i) => (
                  <button
                    key={i}
                    title={`Use ${a.source} avatar`}
                    onClick={async () => {
                      setSelectedAvatarIndex(i);
                      try {
                        await api.setPreferredAvatar(i);
                      } catch {
                        // ignore — UI already updated optimistically
                      }
                    }}
                    className={[
                      'w-12 h-12 border-3 overflow-hidden p-0 cursor-pointer transition-all',
                      i === selectedAvatarIndex
                        ? 'border-nb-lime ring-2 ring-nb-lime'
                        : 'border-nb-border hover:border-nb-text',
                    ].join(' ')}
                  >
                    <Avatar
                      src={a.url}
                      fallbackInitials={a.source[0]?.toUpperCase() ?? '?'}
                      size="sm"
                      className="w-full h-full border-0"
                    />
                  </button>
                ))}
              </div>
            )}
          </div>

          <Button variant="secondary" size="sm" onClick={openPicker}>
            CHANGE
          </Button>
        </div>
      </Card>

      {/* ---- STATS GRID ---- */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        {statCards.map((s) => (
          <Card key={s.label} className="p-0 overflow-hidden">
            <div
              className="px-4 py-1.5 font-display text-xs font-bold uppercase tracking-wider text-black"
              style={{ backgroundColor: s.color }}
            >
              {s.label}
            </div>
            <div className="px-4 py-4">
              <p className="font-display text-3xl font-bold text-nb-text">{s.value}</p>
            </div>
          </Card>
        ))}
      </div>

      {/* ---- MEMORIES BY CONNECTOR ---- */}
      {Object.keys(stats.memoriesByConnector).length > 0 && (
        <Card className="mb-6 p-0 overflow-hidden">
          <div className="bg-nb-black text-white px-4 py-2 font-display text-sm font-bold uppercase">
            MEMORIES BY CONNECTOR
          </div>
          <div className="p-4 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            {Object.entries(stats.memoriesByConnector).map(([type, count]) => {
              const meta = connectorMeta(type);
              return (
                <div key={type} className="border-3 border-nb-border p-3 flex items-center gap-3">
                  <div
                    className="w-10 h-10 border-3 border-nb-border flex items-center justify-center font-display text-lg font-bold text-black shrink-0"
                    style={{ backgroundColor: meta.color }}
                  >
                    {meta.icon}
                  </div>
                  <div>
                    <p className="font-display text-xs font-bold uppercase text-nb-text">
                      {meta.label}
                    </p>
                    <p className="font-mono text-lg font-bold text-nb-text">
                      {count.toLocaleString()}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
        {/* ---- CONNECTED ACCOUNTS ---- */}
        <Card className="p-0 overflow-hidden">
          <div className="bg-nb-black text-white px-4 py-2 font-display text-sm font-bold uppercase">
            CONNECTED ACCOUNTS
          </div>
          <div className="p-3 flex flex-col gap-2">
            {connectedAccounts.length === 0 && (
              <p className="font-mono text-sm text-nb-muted p-2">No accounts connected</p>
            )}
            {connectedAccounts.map((acct) => {
              const meta = connectorMeta(acct.connectorType);
              const isActive = acct.status === 'connected' || acct.status === 'syncing';
              return (
                <div
                  key={acct.id}
                  className="border-2 border-nb-border p-3 flex items-center gap-3"
                >
                  <div
                    className="w-8 h-8 border-2 border-nb-border flex items-center justify-center font-display text-sm font-bold text-black shrink-0"
                    style={{ backgroundColor: meta.color }}
                  >
                    {meta.icon}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-display text-xs font-bold uppercase text-nb-text">
                      {meta.label}
                    </p>
                    <p className="font-mono text-[10px] text-nb-muted truncate">
                      {acct.identifier}
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    <Badge color={isActive ? '#22C55E' : '#888888'}>{acct.status}</Badge>
                    <p className="font-mono text-[10px] text-nb-muted mt-1">
                      {(acct.memoriesCount ?? acct.itemsSynced ?? 0).toLocaleString()} memories
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        </Card>

        {/* ---- TOP ENTITIES ---- */}
        <Card className="p-0 overflow-hidden">
          <div className="bg-nb-black text-white px-4 py-2 font-display text-sm font-bold uppercase">
            TOP ENTITIES
          </div>
          <div className="p-4">
            {topEntities.length === 0 ? (
              <p className="font-mono text-sm text-nb-muted">No entities extracted yet</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {topEntities.map((e) => {
                  // Scale font size by count relative to the max
                  const maxCount = topEntities[0]?.count ?? 1;
                  const ratio = Math.max(0.5, e.count / maxCount);
                  const fontSize = 10 + Math.round(ratio * 10);
                  return (
                    <span
                      key={e.name}
                      className="border-2 border-nb-border px-2 py-1 font-mono font-bold text-nb-text hover:bg-nb-lime hover:text-black transition-colors cursor-default"
                      style={{ fontSize: `${fontSize}px` }}
                      title={`${e.count} mentions`}
                    >
                      {e.name}
                      <span className="text-nb-muted ml-1" style={{ fontSize: '10px' }}>
                        {e.count}
                      </span>
                    </span>
                  );
                })}
              </div>
            )}
          </div>
        </Card>
      </div>

      {/* ---- RECENT ACTIVITY ---- */}
      <Card className="p-0 overflow-hidden">
        <div className="bg-nb-black text-white px-4 py-2 font-display text-sm font-bold uppercase">
          RECENT ACTIVITY
        </div>
        <div className="divide-y divide-nb-border/30">
          {recentMemories.length === 0 && (
            <p className="font-mono text-sm text-nb-muted p-4">No recent memories linked to you</p>
          )}
          {recentMemories.map((mem) => {
            const meta = connectorMeta(mem.connectorType);
            return (
              <div
                key={mem.id}
                className="px-4 py-3 flex items-start gap-3 hover:bg-nb-surface-hover transition-colors"
              >
                <div
                  className="w-7 h-7 border-2 border-nb-border flex items-center justify-center font-display text-xs font-bold text-black shrink-0 mt-0.5"
                  style={{ backgroundColor: meta.color }}
                >
                  {meta.icon}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-mono text-sm text-nb-text leading-snug">
                    {truncate(mem.text, 200)}
                  </p>
                  <div className="flex items-center gap-2 mt-1">
                    <Badge
                      color={SOURCE_COLORS[mem.sourceType] ?? '#888'}
                      className="text-[10px] py-0"
                    >
                      {mem.sourceType}
                    </Badge>
                    <span className="font-mono text-[10px] text-nb-muted">
                      {relativeTime(mem.eventTime)}
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      {/* ---- PICKER MODAL ---- */}
      <ContactPickerModal
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        contacts={filteredContacts}
        loading={contactsLoading}
        search={contactSearch}
        onSearchChange={setContactSearch}
        onSelect={selectIdentity}
      />
    </PageContainer>
  );
}

/* ========== CONTACT PICKER MODAL ========== */

function ContactPickerModal({
  open,
  onClose,
  contacts,
  loading,
  search,
  onSearchChange,
  onSelect,
}: {
  open: boolean;
  onClose: () => void;
  contacts: ContactOption[];
  loading: boolean;
  search: string;
  onSearchChange: (q: string) => void;
  onSelect: (id: string) => void;
}) {
  const filtered = contacts.filter((c) => {
    if (!search) return true;
    const q = search.toLowerCase();
    if (c.displayName.toLowerCase().includes(q)) return true;
    return c.identifiers?.some((i) => i.identifierValue.toLowerCase().includes(q));
  });

  return (
    <Modal open={open} onClose={onClose} title="SELECT YOUR IDENTITY">
      <input
        type="text"
        value={search}
        onChange={(e) => onSearchChange(e.target.value)}
        placeholder="Search contacts..."
        className="w-full border-3 border-nb-border bg-nb-surface font-mono text-sm text-nb-text px-4 py-3 mb-4 shadow-nb placeholder:text-nb-muted"
      />

      <div className="max-h-80 overflow-y-auto flex flex-col gap-1">
        {loading && <Skeleton variant="avatar" count={5} className="mb-2" />}
        {!loading && filtered.length === 0 && (
          <p className="font-mono text-sm text-nb-muted text-center py-4">No contacts found</p>
        )}
        {!loading &&
          filtered.map((c) => {
            const email = c.identifiers?.find((i) => i.identifierType === 'email')?.identifierValue;
            const phone = c.identifiers?.find((i) => i.identifierType === 'phone')?.identifierValue;

            return (
              <button
                key={c.id}
                onClick={() => onSelect(c.id)}
                className="flex items-center gap-3 border-2 border-nb-border p-3 hover:bg-nb-lime hover:text-black transition-colors cursor-pointer text-left w-full"
              >
                <Avatar
                  contactId={c.id}
                  fallbackInitials={c.displayName[0]?.toUpperCase() ?? '?'}
                  size="sm"
                  className="shrink-0"
                />
                <div className="flex-1 min-w-0">
                  <p className="font-display text-sm font-bold uppercase truncate">
                    {c.displayName}
                  </p>
                  <p className="font-mono text-[10px] text-nb-muted truncate">
                    {email ?? phone ?? '--'}
                  </p>
                </div>
              </button>
            );
          })}
      </div>
    </Modal>
  );
}
