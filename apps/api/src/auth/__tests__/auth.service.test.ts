import { describe, it, expect, vi } from 'vitest';
import { AuthService } from '../auth.service';
import { ConnectorsService } from '../../connectors/connectors.service';
import { AccountsService } from '../../accounts/accounts.service';
import { JobsService } from '../../jobs/jobs.service';
import { EventsService } from '../../events/events.service';
import { DbService } from '../../db/db.service';
import { AnalyticsService } from '../../analytics/analytics.service';
import { CryptoService } from '../../crypto/crypto.service';
import { ConfigService } from '../../config/config.service';
import { OAuthStateService } from '../oauth-state.service';
import { DemoService } from '../../demo/demo.service';

function createMockDeps() {
  const { EventEmitter } = require('events');
  const mockConnector = Object.assign(new EventEmitter(), {
    manifest: { id: 'test', authType: 'api-key' },
    initiateAuth: vi.fn(),
    completeAuth: vi.fn(),
    validateAuth: vi.fn().mockResolvedValue(true),
    removeAllListeners: vi.fn(),
  });

  const connectors = {
    get: vi.fn().mockReturnValue(mockConnector),
  } as unknown as ConnectorsService;

  const accountsService = {
    create: vi.fn().mockResolvedValue({ id: 'a1', connectorType: 'test', identifier: 'test' }),
    update: vi.fn().mockResolvedValue({
      id: 'a1',
      connectorType: 'test',
      identifier: 'test',
      status: 'connected',
    }),
    findByTypeAndIdentifier: vi.fn().mockResolvedValue(null),
    getById: vi.fn().mockResolvedValue({ id: 'a1', connectorType: 'test', identifier: 'test' }),
  } as unknown as AccountsService;

  const jobsService = {
    triggerSync: vi.fn().mockResolvedValue({ id: 'j1', status: 'queued' }),
  } as unknown as JobsService;

  const events = {} as EventsService;

  const dbService = {
    db: {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
          limit: vi.fn().mockResolvedValue([{ id: 'user-1' }]),
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

  const crypto = {
    decrypt: vi.fn((s: string) => s),
    encrypt: vi.fn((s: string) => s),
  } as unknown as CryptoService;

  const analytics = {
    capture: vi.fn(),
  } as unknown as AnalyticsService;

  const config = {
    authProvider: 'local',
    gmailClientId: '',
    gmailClientSecret: '',
    baseUrl: 'http://localhost:12412',
  } as unknown as ConfigService;

  const oauthState = {
    savePendingConfig: vi.fn().mockResolvedValue(undefined),
    getPendingConfig: vi.fn().mockResolvedValue(null),
    deletePendingConfig: vi.fn().mockResolvedValue(undefined),
    acquireCreateLock: vi.fn().mockResolvedValue(true),
    releaseCreateLock: vi.fn().mockResolvedValue(undefined),
  } as unknown as OAuthStateService;

  const demoService = {
    cleanup: vi.fn().mockResolvedValue({ deleted: 0 }),
  } as unknown as DemoService;

  return {
    connectors,
    accountsService,
    jobsService,
    events,
    dbService,
    crypto,
    analytics,
    config,
    demoService,
    oauthState,
    mockConnector,
  };
}

function makeService(deps: ReturnType<typeof createMockDeps>) {
  const {
    connectors,
    accountsService,
    jobsService,
    events,
    dbService,
    crypto,
    analytics,
    config,
    demoService,
    oauthState,
  } = deps;
  return new AuthService(
    connectors,
    accountsService,
    jobsService,
    events,
    dbService,
    crypto,
    analytics,
    config,
    demoService,
    oauthState,
  );
}

describe('AuthService', () => {
  describe('initiate', () => {
    it('handles complete auth type', async () => {
      const deps = createMockDeps();
      deps.mockConnector.initiateAuth.mockResolvedValue({
        type: 'complete',
        auth: { accessToken: 'tok' },
      });

      const service = makeService(deps);
      const result = await service.initiate('test', { identifier: 'user1' });

      expect(result.type).toBe('complete');
      expect(deps.accountsService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          connectorType: 'test',
          identifier: 'user1',
          authContext: '{"accessToken":"tok"}',
        }),
      );
      expect(deps.jobsService.triggerSync).toHaveBeenCalledWith('a1', 'test', expect.any(String));
    });

    it('handles redirect auth type and appends state token to URL', async () => {
      const deps = createMockDeps();
      deps.mockConnector.initiateAuth.mockResolvedValue({
        type: 'redirect',
        url: 'https://oauth.example.com',
      });

      const service = makeService(deps);
      const result = await service.initiate('test', {});

      expect(result.type).toBe('redirect');
      expect((result as any).url).toMatch(/^https:\/\/oauth\.example\.com\?state=.+$/);
      expect(deps.oauthState.savePendingConfig).toHaveBeenCalled();
      expect(deps.accountsService.create).not.toHaveBeenCalled();
    });

    it('stores pending config in Redis for redirect auth', async () => {
      const deps = createMockDeps();
      deps.mockConnector.initiateAuth.mockResolvedValue({
        type: 'redirect',
        url: 'https://oauth.example.com',
      });
      deps.mockConnector.completeAuth.mockResolvedValue({ accessToken: 'tok' });

      const service = makeService(deps);
      await service.initiate(
        'test',
        {
          clientId: 'cid',
          clientSecret: 'csec',
          returnTo: '/onboarding',
        },
        'user-1',
      );

      // Verify savePendingConfig was called
      expect(deps.oauthState.savePendingConfig).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          config: expect.objectContaining({ clientId: 'cid', clientSecret: 'csec' }),
          returnTo: '/onboarding',
          userId: 'user-1',
        }),
      );

      // Extract the stateToken that was saved
      const stateToken = (deps.oauthState.savePendingConfig as any).mock.calls[0][0];

      // Mock getPendingConfig to return the saved data for callback
      (deps.oauthState.getPendingConfig as any).mockResolvedValueOnce({
        config: { clientId: 'cid', clientSecret: 'csec' },
        returnTo: '/onboarding',
        userId: 'user-1',
      });

      const result = await service.handleCallback('test', { code: 'abc', state: stateToken });

      expect(deps.oauthState.getPendingConfig).toHaveBeenCalledWith(stateToken);
      expect(deps.mockConnector.completeAuth).toHaveBeenCalledWith(
        expect.objectContaining({
          clientId: 'cid',
          clientSecret: 'csec',
          code: 'abc',
        }),
      );
      expect(result.returnTo).toBe('/onboarding');
    });

    it('strips returnTo from config passed to connector', async () => {
      const deps = createMockDeps();
      deps.mockConnector.initiateAuth.mockResolvedValue({
        type: 'redirect',
        url: 'https://oauth.example.com',
      });

      const service = makeService(deps);
      await service.initiate('test', { clientId: 'cid', returnTo: '/onboarding' });

      expect(deps.mockConnector.initiateAuth).toHaveBeenCalledWith({ clientId: 'cid' });
    });

    it('handles qr-code auth type', async () => {
      const deps = createMockDeps();
      deps.mockConnector.initiateAuth.mockResolvedValue({
        type: 'qr-code',
        qrData: 'data:image/png',
        wsChannel: 'auth:session-1',
      });

      const service = makeService(deps);
      const result = await service.initiate('test', {});

      expect(result.type).toBe('qr-code');
      expect((result as any).qrData).toBe('data:image/png');
      expect((result as any).wsChannel).toBe('auth:session-1');
    });
  });

  describe('getSavedCredentials', () => {
    it('returns null when no credentials saved', async () => {
      const deps = createMockDeps();
      const service = makeService(deps);
      const result = await service.getSavedCredentials('test');
      expect(result).toBeNull();
    });

    it('returns parsed credentials when saved', async () => {
      const deps = createMockDeps();
      (deps.dbService.db.select as any).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            {
              connectorType: 'gmail',
              credentials: '{"clientId":"cid","clientSecret":"csec"}',
            },
          ]),
        }),
      });
      const service = makeService(deps);
      const result = await service.getSavedCredentials('gmail');
      expect(result).toEqual({ clientId: 'cid', clientSecret: 'csec' });
    });
  });

  describe('handleCallback', () => {
    it('completes auth and creates account with state token', async () => {
      const deps = createMockDeps();
      deps.mockConnector.completeAuth.mockResolvedValue({ accessToken: 'callback-tok' });
      (deps.oauthState.getPendingConfig as any).mockResolvedValueOnce({
        config: {},
        userId: 'user-1',
      });

      const service = makeService(deps);
      const result = await service.handleCallback('test', {
        code: 'abc',
        identifier: 'user1',
        state: 'test-state-token',
      });

      expect(deps.oauthState.getPendingConfig).toHaveBeenCalledWith('test-state-token');
      expect(deps.oauthState.deletePendingConfig).toHaveBeenCalledWith('test-state-token');
      expect(deps.accountsService.create).toHaveBeenCalled();
      expect(deps.jobsService.triggerSync).toHaveBeenCalledWith('a1', 'test', expect.any(String));
      expect(result.account).toBeDefined();
      expect(result.returnTo).toBeUndefined();
    });

    it('throws when no userId can be determined', async () => {
      const deps = createMockDeps();
      deps.mockConnector.completeAuth.mockResolvedValue({ accessToken: 'tok' });
      // No state token → no pending config → no userId
      const service = makeService(deps);
      await expect(service.handleCallback('test', { code: 'abc' })).rejects.toThrow(
        'could not determine user',
      );
    });

    it('cleans up pending config after callback', async () => {
      const deps = createMockDeps();
      deps.mockConnector.initiateAuth.mockResolvedValue({
        type: 'redirect',
        url: 'https://oauth.example.com',
      });
      deps.mockConnector.completeAuth.mockResolvedValue({ accessToken: 'tok' });

      const service = makeService(deps);
      await service.initiate('test', { clientId: 'cid', clientSecret: 'csec' }, 'user-1');

      // First callback with state — returns pending config
      (deps.oauthState.getPendingConfig as any).mockResolvedValueOnce({
        config: { clientId: 'cid', clientSecret: 'csec' },
        userId: 'user-1',
      });
      await service.handleCallback('test', { code: 'abc', state: 'state-1' });
      expect(deps.oauthState.deletePendingConfig).toHaveBeenCalledWith('state-1');
    });
  });

  describe('Firebase mode credential injection', () => {
    it('injects server-side Gmail creds when authProvider is firebase', async () => {
      const deps = createMockDeps();
      (deps.config as any).authProvider = 'firebase';
      (deps.config as any).gmailClientId = 'server-cid';
      (deps.config as any).gmailClientSecret = 'server-csec';
      (deps.config as any).baseUrl = 'https://botmem.xyz';
      deps.mockConnector.initiateAuth.mockResolvedValue({
        type: 'redirect',
        url: 'https://accounts.google.com/auth',
      });

      const service = makeService(deps);
      await service.initiate('gmail', {});

      expect(deps.mockConnector.initiateAuth).toHaveBeenCalledWith(
        expect.objectContaining({
          clientId: 'server-cid',
          clientSecret: 'server-csec',
          redirectUri: 'https://botmem.xyz/api/auth/gmail/callback',
        }),
      );
    });

    it('server-side creds override user-provided config in Firebase mode', async () => {
      const deps = createMockDeps();
      (deps.config as any).authProvider = 'firebase';
      (deps.config as any).gmailClientId = 'server-cid';
      (deps.config as any).gmailClientSecret = 'server-csec';
      (deps.config as any).baseUrl = 'https://botmem.xyz';
      deps.mockConnector.initiateAuth.mockResolvedValue({
        type: 'redirect',
        url: 'https://accounts.google.com/auth',
      });

      const service = makeService(deps);
      await service.initiate('gmail', { clientId: 'user-cid', clientSecret: 'user-csec' });

      expect(deps.mockConnector.initiateAuth).toHaveBeenCalledWith(
        expect.objectContaining({
          clientId: 'server-cid',
          clientSecret: 'server-csec',
          redirectUri: 'https://botmem.xyz/api/auth/gmail/callback',
        }),
      );
    });

    it('does not inject server creds in local auth mode', async () => {
      const deps = createMockDeps();
      (deps.config as any).authProvider = 'local';
      (deps.config as any).gmailClientId = 'server-cid';
      (deps.config as any).gmailClientSecret = 'server-csec';
      deps.mockConnector.initiateAuth.mockResolvedValue({
        type: 'redirect',
        url: 'https://accounts.google.com/auth',
      });

      const service = makeService(deps);
      await service.initiate('gmail', {});

      expect(deps.mockConnector.initiateAuth).toHaveBeenCalledWith({});
    });

    it('does not inject Gmail creds for non-Gmail connectors in Firebase mode', async () => {
      const deps = createMockDeps();
      (deps.config as any).authProvider = 'firebase';
      (deps.config as any).gmailClientId = 'server-cid';
      (deps.config as any).gmailClientSecret = 'server-csec';
      deps.mockConnector.initiateAuth.mockResolvedValue({
        type: 'redirect',
        url: 'https://oauth.example.com',
      });

      const service = makeService(deps);
      await service.initiate('slack', {});

      expect(deps.mockConnector.initiateAuth).toHaveBeenCalledWith({});
    });

    it('does not inject when server creds are empty', async () => {
      const deps = createMockDeps();
      (deps.config as any).authProvider = 'firebase';
      (deps.config as any).gmailClientId = '';
      (deps.config as any).gmailClientSecret = '';
      deps.mockConnector.initiateAuth.mockResolvedValue({
        type: 'redirect',
        url: 'https://accounts.google.com/auth',
      });

      const service = makeService(deps);
      await service.initiate('gmail', {});

      const calledWith = deps.mockConnector.initiateAuth.mock.calls[0][0];
      expect(calledWith.clientId).toBeUndefined();
      expect(calledWith.clientSecret).toBeUndefined();
    });
  });

  describe('complete', () => {
    it('creates new account when no accountId', async () => {
      const deps = createMockDeps();
      deps.mockConnector.completeAuth.mockResolvedValue({ accessToken: 'new-tok' });

      const service = makeService(deps);
      await service.complete('test', { params: { code: 'xyz' } });

      expect(deps.accountsService.create).toHaveBeenCalled();
      expect(deps.jobsService.triggerSync).toHaveBeenCalledWith('a1', 'test', expect.any(String));
      expect(deps.accountsService.update).not.toHaveBeenCalled();
    });

    it('updates existing account when accountId provided', async () => {
      const deps = createMockDeps();
      deps.mockConnector.completeAuth.mockResolvedValue({ accessToken: 'updated-tok' });

      const service = makeService(deps);
      await service.complete('test', { accountId: 'a1', params: { code: 'xyz' } });

      expect(deps.accountsService.update).toHaveBeenCalledWith('a1', {
        authContext: '{"accessToken":"updated-tok"}',
        status: 'connected',
      });
      expect(deps.accountsService.create).not.toHaveBeenCalled();
    });
  });
});
