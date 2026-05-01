import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useJobStore } from '../jobStore';
import { useAuthStore } from '../authStore';
import { sharedWs } from '../../lib/ws';

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
    vi.spyOn(useAuthStore, 'getState').mockReturnValue({
      user: { id: 'user-1', email: 'test@example.com', name: 'Test User' },
      accessToken: 'token-1',
    } as ReturnType<typeof useAuthStore.getState>);
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

  describe('connectWs', () => {
    it('subscribes to the private user channel and surfaces quota warnings', () => {
      let handler: ((msg: { channel: string; event: string; data: unknown }) => void) | undefined;
      vi.mocked(sharedWs.onMessage).mockImplementation((cb) => {
        handler = cb;
      });

      useJobStore.getState().connectWs();

      expect(sharedWs.subscribe).toHaveBeenCalledWith('dashboard', 'token-1');
      expect(sharedWs.subscribe).toHaveBeenCalledWith('notifications', 'token-1');
      expect(sharedWs.subscribe).toHaveBeenCalledWith('user:user-1', 'token-1');

      handler?.({
        channel: 'user:user-1',
        event: 'quota:warning',
        data: { used: 500, limit: 500, connectorType: 'gmail' },
      });

      expect(useJobStore.getState().notifications[0]).toMatchObject({
        level: 'warn',
        message:
          'Memory limit reached (500 / 500). gmail sync will continue, but new memories require Pro.',
        read: false,
      });
    });
  });
});
