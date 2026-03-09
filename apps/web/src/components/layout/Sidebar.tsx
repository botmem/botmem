import { NavLink } from 'react-router-dom';
import { cn } from '@botmem/shared';
import { useAuth } from '../../hooks/useAuth';
import { useMemoryBankStore } from '../../store/memoryBankStore';
import { useState, useEffect, useRef, type ReactNode } from 'react';
import { Logo } from '../ui/Logo';

const s = 16;
const navItems: { to: string; label: string; icon: ReactNode }[] = [
  {
    to: '/me',
    label: 'ME',
    icon: (
      <svg
        width={s}
        height={s}
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="8" cy="5" r="3" />
        <path d="M2.5 15a5.5 5.5 0 0 1 11 0" />
      </svg>
    ),
  },
  {
    to: '/dashboard',
    label: 'DASHBOARD',
    icon: (
      <svg
        width={s}
        height={s}
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="1" y="1" width="5.5" height="5.5" />
        <rect x="9.5" y="1" width="5.5" height="5.5" />
        <rect x="1" y="9.5" width="5.5" height="5.5" />
        <rect x="9.5" y="9.5" width="5.5" height="5.5" />
      </svg>
    ),
  },
  {
    to: '/connectors',
    label: 'CONNECTORS',
    icon: (
      <svg
        width={s}
        height={s}
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M6 6.5a2.5 2.5 0 1 1-1.5 1.5" />
        <path d="M10 9.5a2.5 2.5 0 1 1 1.5-1.5" />
      </svg>
    ),
  },
  {
    to: '/memories',
    label: 'MEMORIES',
    icon: (
      <svg
        width={s}
        height={s}
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="8" cy="6" r="4" />
        <circle cx="5" cy="10" r="3.5" />
        <circle cx="11" cy="10" r="3.5" />
      </svg>
    ),
  },
  {
    to: '/contacts',
    label: 'PEOPLE',
    icon: (
      <svg
        width={s}
        height={s}
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="6" cy="4.5" r="2.5" />
        <path d="M1 14a5 5 0 0 1 10 0" />
        <circle cx="12" cy="5" r="2" />
        <path d="M15 14a3.5 3.5 0 0 0-4.5-3.3" />
      </svg>
    ),
  },
  {
    to: '/settings',
    label: 'SETTINGS',
    icon: (
      <svg
        width={s}
        height={s}
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="8" cy="8" r="2.5" />
        <path d="M8 1v2M8 13v2M1 8h2M13 8h2M2.9 2.9l1.4 1.4M11.7 11.7l1.4 1.4M13.1 2.9l-1.4 1.4M4.3 11.7l-1.4 1.4" />
      </svg>
    ),
  },
];

function BankSelector({ collapsed }: { collapsed: boolean }) {
  const { memoryBanks, activeMemoryBankId, setActiveMemoryBank, loadMemoryBanks } =
    useMemoryBankStore();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    loadMemoryBanks();
  }, []);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const activeBank = memoryBanks.find((b) => b.id === activeMemoryBankId);
  const label = activeBank ? activeBank.name : 'ALL BANKS';

  if (collapsed) {
    return (
      <div ref={ref} className="relative px-2 py-2 border-b-3 border-nb-border">
        <button
          onClick={() => setOpen(!open)}
          className="w-full flex items-center justify-center border-2 border-nb-border h-8 hover:bg-nb-lime hover:text-black transition-colors cursor-pointer text-nb-text"
          title={label}
        >
          <svg
            width={14}
            height={14}
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="2" y="2" width="12" height="4" />
            <rect x="2" y="10" width="12" height="4" />
            <circle cx="5" cy="4" r="0.5" fill="currentColor" />
            <circle cx="5" cy="12" r="0.5" fill="currentColor" />
          </svg>
        </button>
        {open && (
          <div className="absolute left-full top-0 ml-1 z-50 border-3 border-nb-border bg-nb-surface shadow-nb min-w-48">
            <button
              onClick={() => {
                setActiveMemoryBank(null);
                setOpen(false);
              }}
              className={cn(
                'w-full text-left px-3 py-2 font-mono text-xs font-bold uppercase tracking-wider cursor-pointer transition-colors',
                !activeMemoryBankId
                  ? 'bg-nb-lime text-black'
                  : 'text-nb-text hover:bg-nb-surface-hover',
              )}
            >
              ALL BANKS
            </button>
            {memoryBanks.map((bank) => (
              <button
                key={bank.id}
                onClick={() => {
                  setActiveMemoryBank(bank.id);
                  setOpen(false);
                }}
                className={cn(
                  'w-full text-left px-3 py-2 font-mono text-xs font-bold uppercase tracking-wider cursor-pointer transition-colors border-t-2 border-nb-border',
                  activeMemoryBankId === bank.id
                    ? 'bg-nb-lime text-black'
                    : 'text-nb-text hover:bg-nb-surface-hover',
                )}
              >
                {bank.name}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div ref={ref} className="relative px-3 py-2 border-b-3 border-nb-border">
      <label className="font-display text-[10px] font-bold uppercase tracking-wider text-nb-muted mb-1 block">
        BANK
      </label>
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between border-3 border-nb-border px-3 py-1.5 font-mono text-xs font-bold uppercase tracking-wider text-nb-text bg-nb-surface hover:border-nb-lime transition-colors cursor-pointer"
      >
        <span className="truncate">{label}</span>
        <span className="ml-2 text-nb-muted">{open ? '\u25B2' : '\u25BC'}</span>
      </button>
      {open && (
        <div className="absolute left-3 right-3 top-full z-50 border-3 border-nb-border bg-nb-surface shadow-nb">
          <button
            onClick={() => {
              setActiveMemoryBank(null);
              setOpen(false);
            }}
            className={cn(
              'w-full text-left px-3 py-2 font-mono text-xs font-bold uppercase tracking-wider cursor-pointer transition-colors',
              !activeMemoryBankId
                ? 'bg-nb-lime text-black'
                : 'text-nb-text hover:bg-nb-surface-hover',
            )}
          >
            ALL BANKS
          </button>
          {memoryBanks.map((bank) => (
            <button
              key={bank.id}
              onClick={() => {
                setActiveMemoryBank(bank.id);
                setOpen(false);
              }}
              className={cn(
                'w-full text-left px-3 py-2 font-mono text-xs font-bold uppercase tracking-wider cursor-pointer transition-colors border-t-2 border-nb-border',
                activeMemoryBankId === bank.id
                  ? 'bg-nb-lime text-black'
                  : 'text-nb-text hover:bg-nb-surface-hover',
              )}
            >
              <div className="flex items-center gap-2">
                <span className="truncate">{bank.name}</span>
                {bank.isDefault === true && (
                  <span className="text-[9px] bg-nb-lime text-black px-1 border border-nb-border shrink-0">
                    DEFAULT
                  </span>
                )}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

interface SidebarProps {
  onClose?: () => void;
}

export function Sidebar({ onClose }: SidebarProps) {
  const { user, logout } = useAuth();
  const [collapsed, setCollapsed] = useState(false);

  return (
    <aside
      className={cn(
        'border-r-4 border-nb-border bg-nb-surface flex flex-col h-screen sticky top-0 transition-all duration-200',
        collapsed ? 'md:w-16 w-60' : 'w-60',
      )}
    >
      <div
        className={cn(
          'border-b-4 border-nb-border p-4 flex items-center',
          collapsed ? 'md:justify-center justify-between' : 'justify-between',
        )}
      >
        {/* Mobile close button */}
        {onClose && (
          <button
            onClick={onClose}
            className="md:hidden border-2 border-nb-border w-8 h-8 flex items-center justify-center font-bold hover:bg-nb-lime hover:text-black transition-colors cursor-pointer text-nb-text"
          >
            ✕
          </button>
        )}
        {(!collapsed || onClose) && (
          <Logo variant="full" height={28} className={cn(onClose && 'mx-auto md:mx-0')} />
        )}
        {collapsed && !onClose && (
          <div className="hidden md:flex items-center justify-center">
            <Logo variant="mark" height={28} />
          </div>
        )}
        {/* Desktop collapse/expand toggle — hidden on mobile */}
        <button
          onClick={() => setCollapsed(!collapsed)}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className="hidden md:flex border-2 border-nb-border w-8 h-8 items-center justify-center font-bold hover:bg-nb-lime hover:text-black transition-colors cursor-pointer text-nb-text"
        >
          {collapsed ? '\u2192' : '\u2190'}
        </button>
      </div>

      <BankSelector collapsed={collapsed} />

      <nav className="flex-1 p-2 flex flex-col gap-1">
        {navItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            onClick={onClose}
            className={({ isActive }) =>
              cn(
                'flex items-center font-display text-sm font-bold uppercase tracking-wider text-nb-text',
                'border-3 border-transparent hover:border-nb-border hover:shadow-nb-sm hover:bg-nb-lime hover:text-black transition-all',
                isActive && 'border-nb-border bg-nb-lime text-black shadow-nb-sm',
                collapsed ? 'md:justify-center md:px-0 gap-3 px-3 py-3' : 'gap-3 px-3 py-3',
              )
            }
          >
            <span className="w-5 h-5 flex items-center justify-center">{item.icon}</span>
            <span className={cn(collapsed && 'md:hidden')}>{item.label}</span>
          </NavLink>
        ))}
      </nav>

      <div
        className={cn(
          'border-t-4 border-nb-border p-4',
          collapsed && 'md:flex md:flex-col md:items-center',
        )}
      >
        {(!collapsed || onClose) && user && (
          <div className="mb-2 md:block">
            <p className="font-mono text-xs font-bold uppercase truncate text-nb-text">
              {user.name}
            </p>
            <p className="font-mono text-xs text-nb-muted truncate">{user.email}</p>
          </div>
        )}
        {collapsed && !onClose && user && <div className="hidden md:block mb-2" />}
        <button
          onClick={logout}
          aria-label="Logout"
          className={cn(
            'font-display text-xs font-bold uppercase border-2 border-nb-border text-nb-text',
            'hover:bg-nb-red hover:text-white transition-colors cursor-pointer',
            collapsed
              ? 'md:w-8 md:h-8 md:flex md:items-center md:justify-center px-3 py-1.5'
              : 'px-3 py-1.5',
          )}
        >
          <span className={cn(collapsed && 'md:hidden')}>LOGOUT</span>
          <span className={cn('hidden', collapsed && 'md:inline')}>⏻</span>
        </button>
      </div>
    </aside>
  );
}
