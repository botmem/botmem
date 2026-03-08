import { NavLink } from 'react-router-dom';
import { cn } from '@botmem/shared';
import { useAuth } from '../../hooks/useAuth';
import { useState, type ReactNode } from 'react';

const s = 16;
const navItems: { to: string; label: string; icon: ReactNode }[] = [
  {
    to: '/me', label: 'ME',
    icon: (
      <svg width={s} height={s} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="8" cy="5" r="3" />
        <path d="M2.5 15a5.5 5.5 0 0 1 11 0" />
      </svg>
    ),
  },
  {
    to: '/dashboard', label: 'DASHBOARD',
    icon: (
      <svg width={s} height={s} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <rect x="1" y="1" width="5.5" height="5.5" />
        <rect x="9.5" y="1" width="5.5" height="5.5" />
        <rect x="1" y="9.5" width="5.5" height="5.5" />
        <rect x="9.5" y="9.5" width="5.5" height="5.5" />
      </svg>
    ),
  },
  {
    to: '/connectors', label: 'CONNECTORS',
    icon: (
      <svg width={s} height={s} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M6 6.5a2.5 2.5 0 1 1-1.5 1.5" />
        <path d="M10 9.5a2.5 2.5 0 1 1 1.5-1.5" />
      </svg>
    ),
  },
  {
    to: '/memories', label: 'MEMORIES',
    icon: (
      <svg width={s} height={s} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="8" cy="6" r="4" />
        <circle cx="5" cy="10" r="3.5" />
        <circle cx="11" cy="10" r="3.5" />
      </svg>
    ),
  },
  {
    to: '/contacts', label: 'PEOPLE',
    icon: (
      <svg width={s} height={s} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="6" cy="4.5" r="2.5" />
        <path d="M1 14a5 5 0 0 1 10 0" />
        <circle cx="12" cy="5" r="2" />
        <path d="M15 14a3.5 3.5 0 0 0-4.5-3.3" />
      </svg>
    ),
  },
  {
    to: '/settings', label: 'SETTINGS',
    icon: (
      <svg width={s} height={s} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="8" cy="8" r="2.5" />
        <path d="M8 1v2M8 13v2M1 8h2M13 8h2M2.9 2.9l1.4 1.4M11.7 11.7l1.4 1.4M13.1 2.9l-1.4 1.4M4.3 11.7l-1.4 1.4" />
      </svg>
    ),
  },
];

export function Sidebar() {
  const { user, logout } = useAuth();
  const [collapsed, setCollapsed] = useState(false);

  return (
    <aside
      className={cn(
        'border-r-4 border-nb-border bg-nb-surface flex flex-col h-screen sticky top-0 transition-all duration-200',
        collapsed ? 'w-16' : 'w-60'
      )}
    >
      <div className={cn(
        'border-b-4 border-nb-border p-4 flex items-center',
        collapsed ? 'justify-center' : 'justify-between'
      )}>
        {!collapsed && (
          <h1 className="font-display text-xl font-bold tracking-wider text-nb-text">BOTMEM</h1>
        )}
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="border-2 border-nb-border w-8 h-8 flex items-center justify-center font-bold hover:bg-nb-lime hover:text-black transition-colors cursor-pointer text-nb-text"
        >
          {collapsed ? '→' : '←'}
        </button>
      </div>

      <nav className="flex-1 p-2 flex flex-col gap-1">
        {navItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) =>
              cn(
                'flex items-center font-display text-sm font-bold uppercase tracking-wider text-nb-text',
                'border-3 border-transparent hover:border-nb-border hover:shadow-nb-sm hover:bg-nb-lime hover:text-black transition-all',
                isActive && 'border-nb-border bg-nb-lime text-black shadow-nb-sm',
                collapsed ? 'justify-center px-0 py-3' : 'gap-3 px-3 py-3'
              )
            }
          >
            <span className="w-5 h-5 flex items-center justify-center">{item.icon}</span>
            {!collapsed && <span>{item.label}</span>}
          </NavLink>
        ))}
      </nav>

      <div className={cn(
        'border-t-4 border-nb-border p-4',
        collapsed && 'flex flex-col items-center'
      )}>
        {!collapsed && user && (
          <div className="mb-2">
            <p className="font-mono text-xs font-bold uppercase truncate text-nb-text">{user.name}</p>
            <p className="font-mono text-xs text-nb-muted truncate">{user.email}</p>
          </div>
        )}
        <button
          onClick={logout}
          className={cn(
            'font-display text-xs font-bold uppercase border-2 border-nb-border text-nb-text',
            'hover:bg-nb-red hover:text-white transition-colors cursor-pointer',
            collapsed ? 'w-8 h-8 flex items-center justify-center' : 'px-3 py-1.5'
          )}
        >
          {collapsed ? '⏻' : 'LOGOUT'}
        </button>
      </div>
    </aside>
  );
}
