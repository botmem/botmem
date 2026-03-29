import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useJobStore } from '../jobStore';

vi.mock('../../lib/ws', () => ({
  sharedWs: {
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    onMessage: vi.fn(),
    offMessage: vi.fn(),
    connect: vi.fn(),
  },
}));

describe('jobStore', () => {
  beforeEach(() => {
    useJobStore.setState({ notifications: [] });
    vi.clearAllMocks();
  });

  describe('addNotification', () => {
    it('adds a notification', () => {
      useJobStore.getState().addNotification('test message', 'info');
      const notifications = useJobStore.getState().notifications;
      expect(notifications).toHaveLength(1);
      expect(notifications[0].message).toBe('test message');
      expect(notifications[0].level).toBe('info');
      expect(notifications[0].read).toBe(false);
    });

    it('limits to 50 notifications', () => {
      for (let i = 0; i < 55; i++) {
        useJobStore.getState().addNotification(`msg ${i}`, 'info');
      }
      expect(useJobStore.getState().notifications).toHaveLength(50);
    });

    it('prepends new notifications', () => {
      useJobStore.getState().addNotification('first', 'info');
      useJobStore.getState().addNotification('second', 'warn');
      expect(useJobStore.getState().notifications[0].message).toBe('second');
    });
  });

  describe('markNotificationRead', () => {
    it('marks a specific notification as read', () => {
      useJobStore.getState().addNotification('test', 'info');
      const id = useJobStore.getState().notifications[0].id;
      useJobStore.getState().markNotificationRead(id);
      expect(useJobStore.getState().notifications[0].read).toBe(true);
    });
  });

  describe('markAllNotificationsRead', () => {
    it('marks all notifications as read', () => {
      useJobStore.getState().addNotification('a', 'info');
      useJobStore.getState().addNotification('b', 'warn');
      useJobStore.getState().markAllNotificationsRead();
      expect(useJobStore.getState().notifications.every((n) => n.read)).toBe(true);
    });
  });

  describe('dismissNotification', () => {
    it('removes a notification', () => {
      useJobStore.getState().addNotification('test', 'info');
      const id = useJobStore.getState().notifications[0].id;
      useJobStore.getState().dismissNotification(id);
      expect(useJobStore.getState().notifications).toHaveLength(0);
    });
  });
});
