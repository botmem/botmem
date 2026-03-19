import { useEffect, useReducer, useCallback } from 'react';
import { PageContainer } from '../components/layout/PageContainer';
import { Card } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Modal } from '../components/ui/Modal';
import { EmptyState } from '../components/ui/EmptyState';
import { Skeleton } from '../components/ui/Skeleton';
import { api } from '../lib/api';
import { Avatar } from '../components/ui/Avatar';
import {
  CONNECTOR_COLORS,
  CONNECTOR_LABELS,
  getConnectorColor,
  getConnectorIcon,
} from '../lib/connectorMeta';

/* ---------- connector display config ---------- */

function connectorMeta(type: string) {
  return {
    icon: getConnectorIcon(type),
    color: getConnectorColor(type),
    label: CONNECTOR_LABELS[type] ?? type,
  };
}

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
  avatars?: string | Array<{ url: string; source: string }>;
  identifiers?: Array<{
    identifierType?: string;
    identifierValue?: string;
    type?: string;
    value?: string;
    [key: string]: unknown;
  }>;
}

/* ---------- reducer ---------- */

interface MeState {
  data: MeData | null;
  loading: boolean;
  pickerOpen: boolean;
  contactOptions: ContactOption[];
  contactSearch: string;
  contactsLoading: boolean;
  selectedAvatarIndex: number;
}

type MeAction =
  | { type: 'FETCH_START' }
  | { type: 'FETCH_SUCCESS'; data: MeData }
  | { type: 'FETCH_ERROR' }
  | { type: 'OPEN_PICKER' }
  | { type: 'CLOSE_PICKER' }
  | { type: 'CONTACTS_LOADING' }
  | { type: 'CONTACTS_LOADED'; contacts: ContactOption[] }
  | { type: 'CONTACTS_ERROR' }
  | { type: 'SET_CONTACT_SEARCH'; search: string }
  | { type: 'SET_AVATAR_INDEX'; index: number };

const initialState: MeState = {
  data: null,
  loading: true,
  pickerOpen: false,
  contactOptions: [],
  contactSearch: '',
  contactsLoading: false,
  selectedAvatarIndex: 0,
};

function meReducer(state: MeState, action: MeAction): MeState {
  switch (action.type) {
    case 'FETCH_START':
      return { ...state, loading: true };
    case 'FETCH_SUCCESS': {
      const data = action.data;
      if (data?.identity) {
        const raw = data.identity.avatars;
        data.identity.avatars = typeof raw === 'string' ? JSON.parse(raw) : raw || [];
      }
      return {
        ...state,
        data,
        loading: false,
        selectedAvatarIndex: data?.identity?.preferredAvatarIndex ?? 0,
      };
    }
    case 'FETCH_ERROR':
      return { ...state, loading: false };
    case 'OPEN_PICKER':
      return { ...state, pickerOpen: true };
    case 'CLOSE_PICKER':
      return { ...state, pickerOpen: false };
    case 'CONTACTS_LOADING':
      return { ...state, contactsLoading: true };
    case 'CONTACTS_LOADED':
      return { ...state, contactsLoading: false, contactOptions: action.contacts };
    case 'CONTACTS_ERROR':
      return { ...state, contactsLoading: false };
    case 'SET_CONTACT_SEARCH':
      return { ...state, contactSearch: action.search };
    case 'SET_AVATAR_INDEX':
      return { ...state, selectedAvatarIndex: action.index };
  }
}

/* ========== SUB-COMPONENTS ========== */

function IdentityHeader({
  identity,
  selectedAvatarIndex,
  onAvatarSelect,
  onChangePicker,
}: {
  identity: MeData['identity'];
  selectedAvatarIndex: number;
  onAvatarSelect: (index: number) => void;
  onChangePicker: () => void;
}) {
  const selectedAvatar = identity.avatars?.[selectedAvatarIndex] ?? identity.avatars?.[0];

  return (
    <Card className="p-0 overflow-hidden mb-6" data-tour="me-identity">
      <div className="bg-nb-lime h-2" />
      <div className="p-6 flex items-center gap-6">
        <Avatar
          contactId={identity.contactId ?? undefined}
          src={selectedAvatar?.url}
          fallbackInitials={(identity.name ?? '?')[0]?.toUpperCase() ?? '?'}
          isSelf
          size="lg"
          className="size-24 shrink-0"
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
              {identity.avatars.map((a) => (
                <button
                  key={`${a.source}-${a.url}`}
                  title={`Use ${a.source} avatar`}
                  onClick={() => onAvatarSelect(identity.avatars.indexOf(a))}
                  className={[
                    'size-12 border-3 overflow-hidden p-0 cursor-pointer transition-all',
                    identity.avatars.indexOf(a) === selectedAvatarIndex
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

        <Button variant="secondary" size="sm" onClick={onChangePicker}>
          CHANGE
        </Button>
      </div>
    </Card>
  );
}

function StatsGrid({ stats }: { stats: MeData['stats'] }) {
  const statCards = [
    {
      label: 'TOTAL MEMORIES',
      value: stats.totalMemories.toLocaleString(),
      color: 'var(--color-nb-lime)',
    },
    {
      label: 'TOTAL CONTACTS',
      value: stats.totalContacts.toLocaleString(),
      color: 'var(--color-nb-blue)',
    },
    {
      label: 'OLDEST MEMORY',
      value: formatDate(stats.oldestMemory),
      color: 'var(--color-nb-pink)',
    },
    {
      label: 'NEWEST MEMORY',
      value: formatDate(stats.newestMemory),
      color: 'var(--color-nb-yellow)',
    },
  ];

  return (
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
  );
}

function MemoriesByConnector({
  memoriesByConnector,
}: {
  memoriesByConnector: Record<string, number>;
}) {
  if (Object.keys(memoriesByConnector).length === 0) return null;

  return (
    <Card className="mb-6 p-0 overflow-hidden">
      <div className="bg-nb-black text-white px-4 py-2 font-display text-sm font-bold uppercase">
        MEMORIES BY CONNECTOR
      </div>
      <div className="p-4 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        {Object.entries(memoriesByConnector).map(([type, count]) => {
          const meta = connectorMeta(type);
          return (
            <div key={type} className="border-3 border-nb-border p-3 flex items-center gap-3">
              <div
                className="size-10 border-3 border-nb-border flex items-center justify-center font-display text-lg font-bold text-black shrink-0"
                style={{ backgroundColor: meta.color }}
              >
                {meta.icon}
              </div>
              <div>
                <p className="font-display text-xs font-bold uppercase text-nb-text">
                  {meta.label}
                </p>
                <p className="font-mono text-lg font-bold text-nb-text">{count.toLocaleString()}</p>
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function ConnectedAccountsList({ accounts }: { accounts: MeData['accounts'] }) {
  return (
    <Card className="p-0 overflow-hidden">
      <div className="bg-nb-black text-white px-4 py-2 font-display text-sm font-bold uppercase">
        CONNECTED ACCOUNTS
      </div>
      <div className="p-3 flex flex-col gap-2">
        {accounts.length === 0 && (
          <p className="font-mono text-sm text-nb-muted p-2">No accounts connected</p>
        )}
        {accounts.map((acct) => {
          const meta = connectorMeta(acct.connectorType);
          const isActive = acct.status === 'connected' || acct.status === 'syncing';
          return (
            <div key={acct.id} className="border-2 border-nb-border p-3 flex items-center gap-3">
              <div
                className="size-8 border-2 border-nb-border flex items-center justify-center font-display text-sm font-bold text-black shrink-0"
                style={{ backgroundColor: meta.color }}
              >
                {meta.icon}
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-display text-xs font-bold uppercase text-nb-text">
                  {meta.label}
                </p>
                <p className="font-mono text-[11px] text-nb-muted truncate">{acct.identifier}</p>
              </div>
              <div className="text-right shrink-0">
                <Badge color={isActive ? 'var(--color-nb-green)' : 'var(--color-nb-muted)'}>
                  {acct.status}
                </Badge>
                <p className="font-mono text-[11px] text-nb-muted mt-1">
                  {(acct.memoriesCount ?? acct.itemsSynced ?? 0).toLocaleString()} memories
                </p>
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function TopEntitiesCloud({ topEntities }: { topEntities: MeData['topEntities'] }) {
  return (
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
  );
}

function RecentActivity({ recentMemories }: { recentMemories: MeData['recentMemories'] }) {
  return (
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
                className="size-7 border-2 border-nb-border flex items-center justify-center font-display text-xs font-bold text-black shrink-0 mt-0.5"
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
                    color={CONNECTOR_COLORS[mem.sourceType] ?? 'var(--color-nb-muted)'}
                    className="text-[11px] py-0"
                  >
                    {mem.sourceType}
                  </Badge>
                  <span className="font-mono text-[11px] text-nb-muted">
                    {relativeTime(mem.eventTime)}
                  </span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </Card>
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
    return c.identifiers?.some((i) =>
      (i.identifierValue || i.value || '').toLowerCase().includes(q),
    );
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
            const emailIdent = c.identifiers?.find((i) => (i.identifierType || i.type) === 'email');
            const phoneIdent = c.identifiers?.find((i) => (i.identifierType || i.type) === 'phone');
            const email = emailIdent?.identifierValue || emailIdent?.value;
            const phone = phoneIdent?.identifierValue || phoneIdent?.value;

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
                  <p className="font-mono text-[11px] text-nb-muted truncate">
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

/* ========== MAIN COMPONENT ========== */

export function MePage() {
  const [state, dispatch] = useReducer(meReducer, initialState);
  const {
    data,
    loading,
    pickerOpen,
    contactOptions,
    contactSearch,
    contactsLoading,
    selectedAvatarIndex,
  } = state;

  const fetchMe = useCallback(async () => {
    try {
      const result = await api.getMe<MeData>();
      dispatch({ type: 'FETCH_SUCCESS', data: result });
    } catch {
      dispatch({ type: 'FETCH_ERROR' });
    }
  }, []);

  useEffect(() => {
    fetchMe();
  }, [fetchMe]);

  const openPicker = async () => {
    dispatch({ type: 'OPEN_PICKER' });
    dispatch({ type: 'CONTACTS_LOADING' });
    try {
      const result = await api.listContacts({ limit: 200 });
      dispatch({ type: 'CONTACTS_LOADED', contacts: result.items });
    } catch {
      dispatch({ type: 'CONTACTS_ERROR' });
    }
  };

  const selectIdentity = async (contactId: string) => {
    try {
      await api.setMe(contactId);
      dispatch({ type: 'CLOSE_PICKER' });
      dispatch({ type: 'FETCH_START' });
      await fetchMe();
    } catch {
      // ignore
    }
  };

  const handleAvatarSelect = async (index: number) => {
    dispatch({ type: 'SET_AVATAR_INDEX', index });
    try {
      await api.setPreferredAvatar(index);
    } catch {
      // ignore -- UI already updated optimistically
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
          onClose={() => dispatch({ type: 'CLOSE_PICKER' })}
          contacts={contactOptions}
          loading={contactsLoading}
          search={contactSearch}
          onSearchChange={(q) => dispatch({ type: 'SET_CONTACT_SEARCH', search: q })}
          onSelect={selectIdentity}
        />
      </PageContainer>
    );
  }

  /* ---------- identified — full page ---------- */

  const { identity, accounts: connectedAccounts, stats, topEntities, recentMemories } = data!;

  // Filter contacts for picker
  const filteredContacts = contactOptions.filter((c) => {
    if (!contactSearch) return true;
    const q = contactSearch.toLowerCase();
    if (c.displayName.toLowerCase().includes(q)) return true;
    return c.identifiers?.some((i) =>
      (i.identifierValue || i.value || '').toLowerCase().includes(q),
    );
  });

  return (
    <PageContainer>
      <IdentityHeader
        identity={identity}
        selectedAvatarIndex={selectedAvatarIndex}
        onAvatarSelect={handleAvatarSelect}
        onChangePicker={openPicker}
      />

      <StatsGrid stats={stats} />

      <MemoriesByConnector memoriesByConnector={stats.memoriesByConnector} />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
        <ConnectedAccountsList accounts={connectedAccounts} />
        <TopEntitiesCloud topEntities={topEntities} />
      </div>

      <RecentActivity recentMemories={recentMemories} />

      {/* ---- PICKER MODAL ---- */}
      <ContactPickerModal
        open={pickerOpen}
        onClose={() => dispatch({ type: 'CLOSE_PICKER' })}
        contacts={filteredContacts}
        loading={contactsLoading}
        search={contactSearch}
        onSearchChange={(q) => dispatch({ type: 'SET_CONTACT_SEARCH', search: q })}
        onSelect={selectIdentity}
      />
    </PageContainer>
  );
}
