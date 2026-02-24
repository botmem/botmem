import { NavLink } from 'react-router-dom';
import { cn } from '@botmem/shared';
import { useAuth } from '../../hooks/useAuth';
import { useState } from 'react';

const navItems = [
  { to: '/dashboard', label: 'DASHBOARD', icon: '◈' },
  { to: '/connectors', label: 'CONNECTORS', icon: '⚡' },
  { to: '/memories', label: 'MEMORIES', icon: '◉' },
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
            <span className="text-lg">{item.icon}</span>
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
