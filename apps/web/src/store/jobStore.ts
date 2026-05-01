import { create } from 'zustand';
import { sharedWs } from '../lib/ws';
import { useAuthStore } from './authStore';
import { formatCompactNumber } from '../lib/formatNumber';

export interface Notification {
  id: string;
  message: string;
  level: 'info' | 'warn' | 'error' | 'success';
  time: string;
  read: boolean;
}

interface JobState {
  notifications: Notification[];
  connectWs: () => void;
  addNotification: (msg: string, level: 'info' | 'warn' | 'error' | 'success') => void;
  markNotificationRead: (id: string) => void;
  markAllNotificationsRead: () => void;
  dismissNotification: (id: string) => void;
}

let wsConnected = false;

function quotaWarningMessage(data: { used?: number; limit?: number; connectorType?: string }) {
  const limitText = typeof data.limit === 'number' ? formatCompactNumber(data.limit) : 'free plan';
  const usedText = typeof data.used === 'number' ? `${formatCompactNumber(data.used)} / ` : '';
  const connector = data.connectorType ? ` ${data.connectorType}` : '';
  return `Memory limit reached (${usedText}${limitText}).${connector} sync will continue, but new memories require Pro.`;
}

export const useJobStore = create<JobState>((set, get) => ({
  notifications: [],

  addNotification: (msg, level) =>
    set((state) => ({
      notifications: [
        {
          id: crypto.randomUUID(),
          message: msg,
          level,
          time: new Date().toISOString(),
          read: false,
        },
        ...state.notifications,
      ].slice(0, 50),
    })),

  markNotificationRead: (id) =>
    set((state) => ({
      notifications: state.notifications.map((n) => (n.id === id ? { ...n, read: true } : n)),
    })),

  markAllNotificationsRead: () =>
    set((state) => ({
      notifications: state.notifications.map((n) => ({ ...n, read: true })),
    })),

  dismissNotification: (id) =>
    set((state) => ({
      notifications: state.notifications.filter((n) => n.id !== id),
    })),

  connectWs: () => {
    if (wsConnected) return;
    wsConnected = true;

    const auth = useAuthStore.getState();
    const token = auth.accessToken ?? undefined;
    sharedWs.subscribe('dashboard', token);
    sharedWs.subscribe('notifications', token);
    if (auth.user?.id) {
      sharedWs.subscribe(`user:${auth.user.id}`, token);
    }

    sharedWs.onMessage((msg) => {
      if (msg.event === 'job:complete') {
        get().addNotification('Sync job completed', 'success');
      }
      if (msg.event === 'connector:warning') {
        get().addNotification(msg.data?.message || 'Connector warning', 'warn');
      }
      if (msg.event === 'quota:warning') {
        get().addNotification(quotaWarningMessage(msg.data || {}), 'warn');
      }
    });
  },
}));
