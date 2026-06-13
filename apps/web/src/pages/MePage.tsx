import { useEffect, useReducer, useCallback } from 'react';
import { PageContainer } from '../components/layout/PageContainer';
import { Card } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { AnimatedNumber } from '../components/ui/AnimatedNumber';
import { Modal } from '../components/ui/Modal';
import { EmptyState } from '../components/ui/EmptyState';
import { Skeleton } from '../components/ui/Skeleton';
import { api } from '../lib/api';
import { formatCompactNumber, formatIntegerNumber } from '../lib/formatNumber';
import { Avatar } from '../components/ui/Avatar';
import { CONNECTOR_LABELS, getConnectorColor, getConnectorIcon } from '../lib/connectorMeta';

/* ---------- connector display config ---------- */

function connectorMeta(type: string) {
  return {
    icon: getConnectorIcon(type),
    color: getConnectorColor(type),
    label: CONNECTOR_LABELS[type] ?? type,
  };
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

export function formatMemoryStatDate(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  // ponytail: dates before 1990 are almost always epoch/default bugs; loosen if imports support archival media.
  if (!Number.isFinite(date.getTime()) || date.getFullYear() < 1990) return null;
  return formatDate(iso);
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
        if (typeof raw === 'string') {
          try {
            data.identity.avatars = JSON.parse(raw);
          } catch {
            data.identity.avatars = [];
          }
        } else {
          data.identity.avatars = raw || [];
        }
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
  const avatarCount = identity.avatars.length;

  return (
    <Card className="p-0 overflow-hidden mb-6" data-tour="me-identity">
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_auto] border-b-3 border-nb-border">
        <div className="bg-nb-lime px-4 py-2 font-display text-xs font-bold uppercase tracking-wider text-black">
          ME / COMMAND CENTER
        </div>
        <div className="hidden lg:block bg-nb-black px-4 py-2 font-display text-xs font-bold uppercase tracking-wider text-white">
          {avatarCount} AVATAR{avatarCount === 1 ? '' : 'S'} INDEXED
        </div>
      </div>
      <div className="p-4 sm:p-6 grid grid-cols-1 lg:grid-cols-[auto_1fr_auto] gap-5 lg:items-center">
        <Avatar
          contactId={identity.contactId ?? undefined}
          src={selectedAvatar?.url}
          fallbackInitials={(identity.name ?? '?')[0]?.toUpperCase() ?? '?'}
          isSelf
          size="lg"
          className="size-24 sm:size-28 shrink-0"
        />

        <div className="flex-1 min-w-0">
          <p className="font-display text-xs font-bold uppercase text-nb-muted mb-1">
            PRIMARY IDENTITY
          </p>
          <h1 className="font-display text-3xl sm:text-5xl font-bold uppercase text-nb-text truncate">
            {identity.name ?? 'Unknown'}
          </h1>
          <div className="mt-2 flex flex-wrap gap-3">
            {identity.email && (
              <span className="font-mono text-xs sm:text-sm text-nb-muted border-2 border-nb-border px-2 py-1">
                {identity.email}
              </span>
            )}
            {identity.phone && (
              <span className="font-mono text-xs sm:text-sm text-nb-muted border-2 border-nb-border px-2 py-1">
                {identity.phone}
              </span>
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

        <div className="lg:self-start">
          <Button variant="secondary" size="sm" onClick={onChangePicker}>
            CHANGE ID
          </Button>
        </div>
      </div>
    </Card>
  );
}

function StatsGrid({ stats }: { stats: MeData['stats'] }) {
  const oldestMemory = formatMemoryStatDate(stats.oldestMemory);
  const statCards = [
    {
      label: 'TOTAL MEMORIES',
      value: stats.totalMemories,
      exactValue: formatIntegerNumber(stats.totalMemories),
      color: 'var(--color-nb-lime)',
      animated: true,
    },
    {
      label: 'TOTAL CONTACTS',
      value: stats.totalContacts,
      exactValue: formatIntegerNumber(stats.totalContacts),
      color: 'var(--color-nb-blue)',
      animated: true,
    },
    ...(oldestMemory
      ? [
          {
            label: 'OLDEST MEMORY',
            value: oldestMemory,
            color: 'var(--color-nb-pink)',
          },
        ]
      : []),
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
            {s.animated ? (
              <AnimatedNumber
                value={s.value}
                className="font-display text-3xl font-bold text-nb-text"
                style={{ display: 'block' }}
              />
            ) : (
              <p className="font-display text-3xl font-bold text-nb-text">{s.value}</p>
            )}
            {'exactValue' in s && (
              <p className="font-mono text-[11px] text-nb-muted mt-1">{s.exactValue} exact</p>
            )}
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
  const entries = Object.entries(memoriesByConnector).sort(([, a], [, b]) => b - a);

  return (
    <Card className="mb-6 p-0 overflow-hidden">
      <div className="bg-nb-black text-white px-4 py-2 font-display text-sm font-bold uppercase">
        CONNECTOR MEMORY MIX
      </div>
      <div className="p-4 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        {entries.map(([type, count]) => {
          const meta = connectorMeta(type);
          return (
            <div
              key={type}
              className="border-3 border-nb-border p-3 flex items-center gap-3 min-w-0"
              title={`${formatIntegerNumber(count)} memories`}
            >
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
                <p className="font-mono text-lg font-bold text-nb-text">
                  {formatCompactNumber(count)}
                </p>
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
        id="identity-search"
        name="identity-search"
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

  const { identity, stats } = data!;

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
