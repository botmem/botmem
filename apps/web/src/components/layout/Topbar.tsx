import { useLocation } from 'react-router-dom';
import { NotificationDropdown } from '../ui/NotificationDropdown';
import { useJobStore } from '../../store/jobStore';
import { ThemeToggle } from '../ui/ThemeToggle';
import { useAuth } from '../../hooks/useAuth';

const pageTitles: Record<string, string> = {
  '/dashboard': 'DASHBOARD',
  '/connectors': 'CONNECTORS',
  '/memories': 'MEMORY EXPLORER',
  '/contacts': 'PEOPLE',
  '/settings': 'SETTINGS',
};

interface TopbarProps {
  onMenuOpen: () => void;
}

export function Topbar({ onMenuOpen }: TopbarProps) {
  const location = useLocation();
  const title = pageTitles[location.pathname] || 'BOTMEM';
  const { notifications, markNotificationRead, markAllNotificationsRead, dismissNotification } =
    useJobStore();
  const { user } = useAuth();

  return (
    <header className="border-b-4 border-nb-border bg-nb-surface">
      <div className="flex items-center justify-between px-3 sm:px-6 py-3">
        <div className="flex items-center">
          <button
            className="md:hidden border-2 border-nb-border size-11 flex items-center justify-center mr-3 hover:bg-nb-lime hover:text-black transition-colors cursor-pointer text-nb-text"
            onClick={onMenuOpen}
            aria-label="Open navigation"
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 18 18"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            >
              <line x1="2" y1="4" x2="16" y2="4" />
              <line x1="2" y1="9" x2="16" y2="9" />
              <line x1="2" y1="14" x2="16" y2="14" />
            </svg>
          </button>
          <h1 className="font-display text-lg sm:text-2xl font-bold tracking-wider text-nb-text">
            {title}
          </h1>
        </div>
        <div className="flex items-center gap-3">
          {user && (
            <div
              className="size-10 border-2 border-nb-border bg-nb-surface flex items-center justify-center font-display text-xs font-bold uppercase text-nb-text"
              title={user.name || user.email}
              aria-label={`Logged in as ${user.name || user.email}`}
            >
              {(user.name || user.email || '?')[0].toUpperCase()}
            </div>
          )}
          <ThemeToggle />
          <NotificationDropdown
            notifications={notifications}
            onMarkRead={markNotificationRead}
            onMarkAllRead={markAllNotificationsRead}
            onDismiss={dismissNotification}
          />
          <div className="hidden sm:block font-mono text-xs text-nb-muted uppercase">
            {new Date().toLocaleDateString('en-US', {
              weekday: 'short',
              month: 'short',
              day: 'numeric',
            })}
          </div>
        </div>
      </div>
    </header>
  );
}
