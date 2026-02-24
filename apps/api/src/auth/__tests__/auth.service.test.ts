import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuthService } from '../auth.service';
import { ConnectorsService } from '../../connectors/connectors.service';
import { AccountsService } from '../../accounts/accounts.service';
import { JobsService } from '../../jobs/jobs.service';
import { EventsService } from '../../events/events.service';
import { DbService } from '../../db/db.service';

function createMockDeps() {
  const mockConnector = {
    manifest: { id: 'test', authType: 'api-key' },
    initiateAuth: vi.fn(),
    completeAuth: vi.fn(),
    validateAuth: vi.fn().mockResolvedValue(true),
  };

  const connectors = {
    get: vi.fn().mockReturnValue(mockConnector),
  } as unknown as ConnectorsService;

  const accountsService = {
    create: vi.fn().mockResolvedValue({ id: 'a1', connectorType: 'test', identifier: 'test' }),
    update: vi.fn().mockResolvedValue({ id: 'a1', connectorType: 'test', identifier: 'test', status: 'connected' }),
  } as unknown as AccountsService;

  const jobsService = {
    triggerSync: vi.fn().mockResolvedValue({ id: 'j1', status: 'queued' }),
  } as unknown as JobsService;

  const events = {} as EventsService;

  const dbService = {
    db: {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            get: vi.fn().mockReturnValue(null),
          }),
        }),
      }),
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          onConflictDoUpdate: vi.fn().mockReturnValue({
            run: vi.fn(),
          }),
        }),
      }),
    },
  } as unknown as DbService;

  return { connectors, accountsService, jobsService, events, dbService, mockConnector };
}

describe('AuthService', () => {
  describe('initiate', () => {
    it('handles complete auth type', async () => {
      const { connectors, accountsService, jobsService, events, dbService, mockConnector } = createMockDeps();
      mockConnector.initiateAuth.mockResolvedValue({
        type: 'complete',
        auth: { accessToken: 'tok' },
      });

      const service = new AuthService(connectors, accountsService, jobsService, events, dbService);
      const result = await service.initiate('test', { identifier: 'user1' });

      expect(result.type).toBe('complete');
      expect(accountsService.create).toHaveBeenCalledWith({
        connectorType: 'test',
        identifier: 'user1',
        authContext: '{"accessToken":"tok"}',
      });
      expect(jobsService.triggerSync).toHaveBeenCalledWith('a1', 'test', expect.any(String));
    });

    it('handles redirect auth type', async () => {
      const { connectors, accountsService, jobsService, events, dbService, mockConnector } = createMockDeps();
      mockConnector.initiateAuth.mockResolvedValue({
        type: 'redirect',
        url: 'https://oauth.example.com',
      });

      const service = new AuthService(connectors, accountsService, jobsService, events, dbService);
      const result = await service.initiate('test', {});

      expect(result.type).toBe('redirect');
      expect((result as any).url).toBe('https://oauth.example.com');
      expect(accountsService.create).not.toHaveBeenCalled();
    });

    it('stores pending config for redirect auth', async () => {
      const { connectors, accountsService, jobsService, events, dbService, mockConnector } = createMockDeps();
      mockConnector.initiateAuth.mockResolvedValue({
        type: 'redirect',
        url: 'https://oauth.example.com',
      });
      mockConnector.completeAuth.mockResolvedValue({ accessToken: 'tok' });

      const service = new AuthService(connectors, accountsService, jobsService, events, dbService);
      await service.initiate('test', { clientId: 'cid', clientSecret: 'csec', returnTo: '/onboarding' });

      const result = await service.handleCallback('test', { code: 'abc' });

      // completeAuth should receive merged config with clientId/clientSecret
      expect(mockConnector.completeAuth).toHaveBeenCalledWith({
        clientId: 'cid',
        clientSecret: 'csec',
        code: 'abc',
      });
      expect(result.returnTo).toBe('/onboarding');
    });

    it('strips returnTo from config passed to connector', async () => {
      const { connectors, accountsService, jobsService, events, dbService, mockConnector } = createMockDeps();
      mockConnector.initiateAuth.mockResolvedValue({
        type: 'redirect',
        url: 'https://oauth.example.com',
      });

      const service = new AuthService(connectors, accountsService, jobsService, events, dbService);
      await service.initiate('test', { clientId: 'cid', returnTo: '/onboarding' });

      expect(mockConnector.initiateAuth).toHaveBeenCalledWith({ clientId: 'cid' });
    });

    it('handles qr-code auth type', async () => {
      const { connectors, accountsService, jobsService, events, dbService, mockConnector } = createMockDeps();
      mockConnector.initiateAuth.mockResolvedValue({
        type: 'qr-code',
        qrData: 'data:image/png',
        wsChannel: 'auth:session-1',
      });

      const service = new AuthService(connectors, accountsService, jobsService, events, dbService);
      const result = await service.initiate('test', {});

      expect(result.type).toBe('qr-code');
      expect((result as any).qrData).toBe('data:image/png');
      expect((result as any).wsChannel).toBe('auth:session-1');
    });
  });

  describe('getSavedCredentials', () => {
    it('returns null when no credentials saved', async () => {
      const { connectors, accountsService, jobsService, events, dbService } = createMockDeps();
      const service = new AuthService(connectors, accountsService, jobsService, events, dbService);
      const result = await service.getSavedCredentials('test');
      expect(result).toBeNull();
    });

    it('returns parsed credentials when saved', async () => {
      const { connectors, accountsService, jobsService, events, dbService } = createMockDeps();
      (dbService.db.select as any).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            get: vi.fn().mockReturnValue({
              connectorType: 'gmail',
              credentials: '{"clientId":"cid","clientSecret":"csec"}',
            }),
          }),
        }),
      });
      const service = new AuthService(connectors, accountsService, jobsService, events, dbService);
      const result = await service.getSavedCredentials('gmail');
      expect(result).toEqual({ clientId: 'cid', clientSecret: 'csec' });
    });
  });

  describe('handleCallback', () => {
    it('completes auth and creates account', async () => {
      const { connectors, accountsService, jobsService, events, dbService, mockConnector } = createMockDeps();
      mockConnector.completeAuth.mockResolvedValue({ accessToken: 'callback-tok' });

      const service = new AuthService(connectors, accountsService, jobsService, events, dbService);
      const result = await service.handleCallback('test', { code: 'abc', identifier: 'user1' });

      expect(mockConnector.completeAuth).toHaveBeenCalledWith({ code: 'abc', identifier: 'user1' });
      expect(accountsService.create).toHaveBeenCalled();
      expect(jobsService.triggerSync).toHaveBeenCalledWith('a1', 'test', expect.any(String));
      expect(result.account).toBeDefined();
      expect(result.returnTo).toBeUndefined();
    });

    it('cleans up pending config after callback', async () => {
      const { connectors, accountsService, jobsService, events, dbService, mockConnector } = createMockDeps();
      mockConnector.initiateAuth.mockResolvedValue({ type: 'redirect', url: 'https://oauth.example.com' });
      mockConnector.completeAuth.mockResolvedValue({ accessToken: 'tok' });

      const service = new AuthService(connectors, accountsService, jobsService, events, dbService);
      await service.initiate('test', { clientId: 'cid', clientSecret: 'csec' });
      await service.handleCallback('test', { code: 'abc' });

      // Second callback should not have stored config
      mockConnector.completeAuth.mockClear();
      await service.handleCallback('test', { code: 'def' });
      expect(mockConnector.completeAuth).toHaveBeenCalledWith({ code: 'def' });
    });
  });

  describe('complete', () => {
    it('creates new account when no accountId', async () => {
      const { connectors, accountsService, jobsService, events, dbService, mockConnector } = createMockDeps();
      mockConnector.completeAuth.mockResolvedValue({ accessToken: 'new-tok' });

      const service = new AuthService(connectors, accountsService, jobsService, events, dbService);
      await service.complete('test', { params: { code: 'xyz' } });

      expect(accountsService.create).toHaveBeenCalled();
      expect(jobsService.triggerSync).toHaveBeenCalledWith('a1', 'test', expect.any(String));
      expect(accountsService.update).not.toHaveBeenCalled();
    });

    it('updates existing account when accountId provided', async () => {
      const { connectors, accountsService, jobsService, events, dbService, mockConnector } = createMockDeps();
      mockConnector.completeAuth.mockResolvedValue({ accessToken: 'updated-tok' });

      const service = new AuthService(connectors, accountsService, jobsService, events, dbService);
      await service.complete('test', { accountId: 'a1', params: { code: 'xyz' } });

      expect(accountsService.update).toHaveBeenCalledWith('a1', {
        authContext: '{"accessToken":"updated-tok"}',
        status: 'connected',
      });
      expect(accountsService.create).not.toHaveBeenCalled();
    });
  });
});
