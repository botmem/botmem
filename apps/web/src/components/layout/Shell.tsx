import { useEffect, useState } from 'react';
import { Outlet } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';

import { RecoveryKeyModal } from '../ui/RecoveryKeyModal';
import { ReauthModal } from '../ui/ReauthModal';
import { TourManager } from '../tour/TourManager';
import { api } from '../../lib/api';
import { useAuthStore } from '../../store/authStore';
import { useMemoryStore } from '../../store/memoryStore';

export function Shell() {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [reauthOpen, setReauthOpen] = useState(false);
  const accessToken = useAuthStore((s) => s.accessToken);
  const needsRecoveryKey = useAuthStore((s) => s.needsRecoveryKey);

  useEffect(() => {
    if (needsRecoveryKey) setReauthOpen(true);
  }, [needsRecoveryKey]);

  useEffect(() => {
    if (!accessToken) return;
    let cancelled = false;
    const checkRecoveryStatus = async () => {
      try {
        const stats = await api.getMemoryStats();
        if (cancelled) return;
        useMemoryStore.setState({ memoryStats: stats });
        if (stats.needsRecoveryKey) {
          useAuthStore.setState({ needsRecoveryKey: true });
        }
      } catch {
        // Auth refresh and route-level requests handle visible failures.
      }
    };
    void checkRecoveryStatus();
    const interval = window.setInterval(checkRecoveryStatus, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [accessToken]);

  return (
    <div className="flex min-h-screen">
      {/* Desktop sidebar — hidden on mobile, shown in normal flow on md+ */}
      <div className="hidden md:flex">
        <Sidebar />
      </div>

      {/* Mobile sidebar drawer overlay */}
      {mobileNavOpen && (
        <div
          className="fixed inset-0 bg-nb-bg/80 z-40 md:hidden"
          role="button"
          tabIndex={0}
          onClick={() => setMobileNavOpen(false)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') setMobileNavOpen(false);
          }}
        />
      )}

      {/* Mobile sidebar drawer */}
      {mobileNavOpen && (
        <div className="fixed inset-y-0 left-0 z-50 w-60 md:hidden">
          <Sidebar onClose={() => setMobileNavOpen(false)} />
        </div>
      )}

      <div className="flex-1 flex flex-col min-w-0">
        <Topbar onMenuOpen={() => setMobileNavOpen(true)} />
        <main className="flex-1 overflow-auto">
          <Outlet />
        </main>
      </div>
      <RecoveryKeyModal />
      <ReauthModal open={reauthOpen && needsRecoveryKey} onClose={() => setReauthOpen(false)} />
      <TourManager />
    </div>
  );
}
