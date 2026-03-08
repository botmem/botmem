import { useLocation } from 'react-router-dom';
import { NotificationDropdown } from '../ui/NotificationDropdown';
import { useJobStore } from '../../store/jobStore';

const pageTitles: Record<string, string> = {
  '/dashboard': 'DASHBOARD',
  '/connectors': 'CONNECTORS',
  '/memories': 'MEMORY EXPLORER',
  '/contacts': 'PEOPLE',
  '/settings': 'SETTINGS',
};

export function Topbar() {
  const location = useLocation();
  const title = pageTitles[location.pathname] || 'BOTMEM';
  const { notifications, markNotificationRead, markAllNotificationsRead, dismissNotification } = useJobStore();

  return (
    <header className="border-b-4 border-nb-border bg-nb-surface">
      <div className="flex items-center justify-between px-6 py-3">
        <h2 className="font-display text-2xl font-bold tracking-wider text-nb-text">{title}</h2>
        <div className="flex items-center gap-4">
          <NotificationDropdown
            notifications={notifications}
            onMarkRead={markNotificationRead}
            onMarkAllRead={markAllNotificationsRead}
            onDismiss={dismissNotification}
          />
          <div className="font-mono text-xs text-nb-muted uppercase">
            {new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
          </div>
        </div>
      </div>
    </header>
  );
}
