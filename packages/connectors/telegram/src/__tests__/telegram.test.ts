import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock GramJS before importing connector
vi.mock('telegram', () => {
  const mockSession = {
    save: vi.fn().mockReturnValue('mock-session-string'),
  };

  const MockTelegramClient = vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    sendCode: vi.fn().mockResolvedValue({ phoneCodeHash: 'mock-hash' }),
    getMe: vi.fn().mockResolvedValue({
      id: BigInt(123456),
      firstName: 'Test',
      lastName: 'User',
      username: 'testuser',
      phone: '+1234567890',
    }),
    getDialogs: vi.fn().mockResolvedValue([]),
    getMessages: vi.fn().mockResolvedValue([]),
    downloadMedia: vi.fn().mockResolvedValue(null),
    invoke: vi.fn().mockResolvedValue({ users: [] }),
    session: mockSession,
    computePasswordSRP: vi.fn().mockResolvedValue({}),
  }));

  return { TelegramClient: MockTelegramClient };
});

vi.mock('telegram/sessions/index.js', () => ({
  StringSession: vi.fn().mockImplementation((s: string) => ({ _session: s })),
}));

vi.mock('telegram/tl/index.js', () => ({
  Api: {
    auth: {
      SignIn: vi
        .fn()
        .mockImplementation((params: unknown) => ({ ...(params as object), _: 'auth.SignIn' })),
      CheckPassword: vi
        .fn()
        .mockImplementation((params: unknown) => ({
          ...(params as object),
          _: 'auth.CheckPassword',
        })),
    },
    contacts: {
      GetContacts: vi
        .fn()
        .mockImplementation((params: unknown) => ({
          ...(params as object),
          _: 'contacts.GetContacts',
        })),
    },
    account: {
      GetPassword: vi.fn().mockImplementation(() => ({ _: 'account.GetPassword' })),
    },
  },
}));

vi.mock('telegram/Password.js', () => ({
  computeCheck: vi.fn().mockResolvedValue({}),
}));

describe('TelegramConnector', () => {
  let TelegramConnector: typeof import('../index.js').TelegramConnector;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import('../index.js');
    TelegramConnector = mod.TelegramConnector;
  });

  it('has correct manifest', () => {
    const connector = new TelegramConnector();
    expect(connector.manifest.id).toBe('telegram');
    expect(connector.manifest.authType).toBe('phone-code');
    expect(connector.manifest.entities).toEqual(['person', 'message']);
    expect(connector.manifest.trustScore).toBe(0.8);
    expect(connector.manifest.color).toBe('#26A5E4');
  });

  it('initiateAuth sends code and returns phone-code result', async () => {
    const connector = new TelegramConnector();
    const result = await connector.initiateAuth({ phone: '+1234567890' });

    expect(result.type).toBe('phone-code');
    if (result.type === 'phone-code') {
      expect(result.phoneCodeHash).toBe('mock-hash');
      expect(result.wsChannel).toMatch(/^auth:telegram-/);
    }
  });

  it('initiateAuth throws without phone', async () => {
    const connector = new TelegramConnector();
    await expect(connector.initiateAuth({})).rejects.toThrow('Phone number is required');
  });

  it('validateAuth returns false for missing session', async () => {
    const connector = new TelegramConnector();
    const valid = await connector.validateAuth({ raw: {} });
    expect(valid).toBe(false);
  });

  it('validateAuth returns true for valid session', async () => {
    const connector = new TelegramConnector();
    const valid = await connector.validateAuth({ raw: { session: 'mock-session' } });
    expect(valid).toBe(true);
  });

  it('embed extracts phone-based sender entity', () => {
    const connector = new TelegramConnector();
    const result = connector.embed(
      {
        sourceType: 'message',
        sourceId: 'telegram:123:456',
        timestamp: new Date().toISOString(),
        content: {
          text: 'Hello world',
          participants: ['+1234567890'],
          metadata: {
            chatId: '123',
            chatName: 'Test Chat',
            isGroup: false,
            senderPhone: '+1234567890',
            senderName: 'John Doe',
            senderUsername: 'johndoe',
          },
        },
      },
      'Hello world',
      {
        accountId: 'acc1',
        auth: {},
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      },
    );

    expect(result.text).toBe('Hello world');
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0].type).toBe('person');
    expect(result.entities[0].role).toBe('sender');
    expect(result.entities[0].id).toContain('phone:+1234567890');
    expect(result.entities[0].id).toContain('name:John Doe');
    expect(result.entities[0].id).toContain('username:johndoe');
  });

  it('embed extracts group entity', () => {
    const connector = new TelegramConnector();
    const result = connector.embed(
      {
        sourceType: 'message',
        sourceId: 'telegram:123:456',
        timestamp: new Date().toISOString(),
        content: {
          text: 'Group message',
          participants: [],
          metadata: {
            chatId: '123',
            chatName: 'Dev Team',
            isGroup: true,
            senderUsername: 'alice',
            senderName: 'Alice',
            senderId: '789',
          },
        },
      },
      'Group message',
      {
        accountId: 'acc1',
        auth: {},
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      },
    );

    expect(result.entities).toHaveLength(2);
    expect(result.entities[0].type).toBe('group');
    expect(result.entities[0].id).toContain('telegram_group:123');
    expect(result.entities[0].id).toContain('name:Dev Team');
    expect(result.entities[1].type).toBe('person');
    expect(result.entities[1].id).toContain('telegram_username:alice');
  });

  it('embed handles username-only sender (no phone)', () => {
    const connector = new TelegramConnector();
    const result = connector.embed(
      {
        sourceType: 'message',
        sourceId: 'telegram:123:456',
        timestamp: new Date().toISOString(),
        content: {
          text: 'No phone',
          participants: [],
          metadata: {
            chatId: '123',
            isGroup: false,
            senderUsername: 'bob',
            senderName: 'Bob',
            senderId: '999',
          },
        },
      },
      'No phone',
      {
        accountId: 'acc1',
        auth: {},
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      },
    );

    expect(result.entities).toHaveLength(1);
    expect(result.entities[0].id).toContain('telegram_username:bob');
    expect(result.entities[0].id).toContain('name:Bob');
  });
});
