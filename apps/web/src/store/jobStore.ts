import { create } from 'zustand';
import { sharedWs } from '../lib/ws';
import { useAuthStore } from './authStore';

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

    const token = useAuthStore.getState().accessToken ?? undefined;
    sharedWs.subscribe('dashboard', token);

    sharedWs.onMessage((msg) => {
      if (msg.event === 'job:complete') {
        get().addNotification('Sync job completed', 'success');
      }
      if (msg.event === 'connector:warning') {
        get().addNotification(msg.data?.message || 'Connector warning', 'warn');
      }
    });
  },
}));
