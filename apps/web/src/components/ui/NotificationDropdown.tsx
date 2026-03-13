import { cn } from '@botmem/shared';
import { useEffect, useRef, useState } from 'react';

export interface Notification {
  id: string;
  message: string;
  level: 'info' | 'warn' | 'error' | 'success';
  time: string;
  read: boolean;
}

interface NotificationDropdownProps {
  notifications: Notification[];
  onMarkRead: (id: string) => void;
  onMarkAllRead: () => void;
  onDismiss: (id: string) => void;
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

const levelColors: Record<Notification['level'], string> = {
  info: 'var(--color-nb-blue)',
  warn: 'var(--color-nb-yellow)',
  error: 'var(--color-nb-red)',
  success: 'var(--color-nb-lime)',
};

export function NotificationDropdown({
  notifications,
  onMarkRead,
  onMarkAllRead,
  onDismiss,
}: NotificationDropdownProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const unreadCount = notifications.filter((n) => !n.read).length;
  const visible = notifications.slice(0, 20);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) {
      document.addEventListener('click', handleClickOutside);
    }
    return () => document.removeEventListener('click', handleClickOutside);
  }, [open]);

  return (
    <div ref={containerRef} className="relative">
      {/* Bell button */}
      <button
        onClick={() => setOpen((prev) => !prev)}
        className={cn(
          'relative border-3 border-nb-border bg-nb-surface shadow-nb p-2',
          'hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-nb-sm',
          'active:translate-x-[4px] active:translate-y-[4px] active:shadow-none',
          'transition-all duration-100 cursor-pointer',
        )}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          className="text-nb-text"
        >
          <path
            d="M8 1C5.79 1 4 2.79 4 5v2.5L2.5 9.5v1h11v-1L12 7.5V5c0-2.21-1.79-4-4-4zM6.5 12a1.5 1.5 0 003 0h-3z"
            fill="currentColor"
          />
        </svg>

        {unreadCount > 0 && (
          <span className="absolute -top-1.5 -right-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-nb-red border-2 border-nb-border px-1 font-mono text-[10px] font-bold text-white leading-none">
            {unreadCount}
          </span>
        )}
      </button>

      {/* Dropdown */}
      {open && (
        <div
          className={cn(
            'absolute right-0 top-full mt-2 z-50 w-80',
            'border-3 border-nb-border bg-nb-surface shadow-nb',
          )}
        >
          {/* Header */}
          <div className="flex items-center justify-between border-b-3 border-nb-border px-3 py-2">
            <span className="font-display text-xs font-bold uppercase tracking-wider text-nb-text">
              Notifications
            </span>
            {unreadCount > 0 && (
              <button
                onClick={onMarkAllRead}
                className="font-mono text-[10px] font-bold uppercase text-nb-muted hover:text-nb-text transition-colors cursor-pointer"
              >
                Mark all read
              </button>
            )}
          </div>

          {/* List */}
          <div className="max-h-80 overflow-y-auto">
            {visible.length === 0 ? (
              <div className="px-3 py-6 text-center font-mono text-xs text-nb-muted">
                No notifications
              </div>
            ) : (
              visible.map((n) => (
                <div
                  key={n.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => !n.read && onMarkRead(n.id)}
                  onKeyDown={(e) => {
                    if ((e.key === 'Enter' || e.key === ' ') && !n.read) onMarkRead(n.id);
                  }}
                  className={cn(
                    'flex items-start gap-2 px-3 py-2 border-b border-nb-border/30 cursor-pointer',
                    'hover:bg-nb-surface-muted transition-colors',
                    !n.read && 'bg-nb-surface-muted/50',
                  )}
                >
                  {/* Level dot */}
                  <span
                    className="mt-1.5 size-2 shrink-0 rounded-full border border-nb-border"
                    style={{ backgroundColor: levelColors[n.level] }}
                  />

                  {/* Content */}
                  <div className="min-w-0 flex-1">
                    <p
                      className={cn(
                        'font-mono text-xs leading-tight truncate',
                        n.read ? 'text-nb-muted' : 'text-nb-text font-medium',
                      )}
                    >
                      {n.message}
                    </p>
                    <span className="font-mono text-[10px] text-nb-muted">
                      {relativeTime(n.time)}
                    </span>
                  </div>

                  {/* Dismiss */}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onDismiss(n.id);
                    }}
                    className="mt-0.5 shrink-0 text-nb-muted hover:text-nb-text transition-colors cursor-pointer"
                  >
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                      <path
                        d="M9 3L3 9M3 3l6 6"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="square"
                      />
                    </svg>
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
