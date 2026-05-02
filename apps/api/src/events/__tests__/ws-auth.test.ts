import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventsGateway } from '../events.gateway';
import type { JwtService } from '@nestjs/jwt';
import type { ConfigService } from '../../config/config.service';
import type { DbService } from '../../db/db.service';
import type { FirebaseAuthService } from '../../user-auth/firebase-auth.service';
import { EventsService } from '../events.service';
import { WebSocket } from 'ws';
import { IncomingMessage } from 'http';
import { Socket } from 'net';

describe('EventsGateway WebSocket Auth', () => {
  let gateway: EventsGateway;
  let jwtService: { verify: ReturnType<typeof vi.fn> };
  let configService: { jwtAccessSecret: string; authProvider: string };
  let eventsService: EventsService;
  let dbService: { db: Record<string, unknown>; userDb: ReturnType<typeof vi.fn> };
  let firebaseAuthService: {
    verifyIdToken: ReturnType<typeof vi.fn>;
    findOrCreateUser: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    jwtService = { verify: vi.fn() };
    configService = { jwtAccessSecret: 'test-secret', authProvider: 'local' };
    eventsService = new EventsService();
    dbService = { db: {}, userDb: vi.fn((_userId: string, fn) => fn({})) };
    firebaseAuthService = {
      verifyIdToken: vi.fn(),
      findOrCreateUser: vi.fn(),
    };

    gateway = new EventsGateway(
      eventsService,
      jwtService as unknown as JwtService,
      configService as unknown as ConfigService,
      dbService as unknown as DbService,
      firebaseAuthService as unknown as FirebaseAuthService,
    );
  });

  function mockClient(): WebSocket & {
    send: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  } {
    return {
      close: vi.fn(),
      readyState: WebSocket.OPEN,
      send: vi.fn(),
    } as unknown as WebSocket & { send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
  }

  function mockReq(url: string): IncomingMessage {
    const socket = new Socket();
    const req = new IncomingMessage(socket);
    req.url = url;
    req.headers = { host: 'localhost:12412' };
    return req;
  }

  it('should accept connection without token (unauthenticated)', () => {
    const client = mockClient();
    const req = mockReq('/events');

    gateway.handleConnection(client, req);

    // Connection is accepted but client is unauthenticated
    expect(client.close).not.toHaveBeenCalled();
  });

  it('should reject auth message with invalid token', async () => {
    const client = mockClient();
    const req = mockReq('/events');
    jwtService.verify.mockImplementation(() => {
      throw new Error('Invalid token');
    });

    gateway.handleConnection(client, req);
    await gateway.handleAuth(client, { token: 'bad-token' });

    expect(client.send).toHaveBeenCalledWith(
      JSON.stringify({ event: 'auth', data: { ok: false, reason: 'Invalid token' } }),
    );
    expect(client.close).toHaveBeenCalledWith(4401, 'Invalid token');
  });

  it('should authenticate client with valid JWT', async () => {
    const client = mockClient();
    const req = mockReq('/events');
    jwtService.verify.mockReturnValue({ sub: 'user-1', email: 'test@test.com' });

    gateway.handleConnection(client, req);
    await gateway.handleAuth(client, { token: 'valid-jwt' });

    expect(client.close).not.toHaveBeenCalled();
    expect(client.send).toHaveBeenCalledWith(JSON.stringify({ event: 'auth', data: { ok: true } }));
    expect(jwtService.verify).toHaveBeenCalledWith('valid-jwt', {
      secret: 'test-secret',
    });
  });

  it('should authenticate client with Firebase ID token when authProvider=firebase', async () => {
    configService.authProvider = 'firebase';
    const client = mockClient();
    const req = mockReq('/events');
    firebaseAuthService.verifyIdToken.mockResolvedValue({ uid: 'fb-uid-1' });
    firebaseAuthService.findOrCreateUser.mockResolvedValue({ user: { id: 'user-1' } });

    gateway.handleConnection(client, req);
    await gateway.handleAuth(client, { token: 'firebase-id-token' });

    expect(client.close).not.toHaveBeenCalled();
    expect(client.send).toHaveBeenCalledWith(JSON.stringify({ event: 'auth', data: { ok: true } }));
    expect(firebaseAuthService.verifyIdToken).toHaveBeenCalledWith('firebase-id-token');
    expect(jwtService.verify).not.toHaveBeenCalled();
  });

  it('should reject invalid Firebase token', async () => {
    configService.authProvider = 'firebase';
    const client = mockClient();
    const req = mockReq('/events');
    firebaseAuthService.verifyIdToken.mockRejectedValue(new Error('Invalid Firebase ID token'));

    gateway.handleConnection(client, req);
    await gateway.handleAuth(client, { token: 'bad-firebase-token' });

    expect(client.send).toHaveBeenCalledWith(
      JSON.stringify({ event: 'auth', data: { ok: false, reason: 'Invalid token' } }),
    );
    expect(client.close).toHaveBeenCalledWith(4401, 'Invalid token');
  });

  it('should reject subscribe from unauthenticated client', async () => {
    const client = mockClient();
    const req = mockReq('/events');

    gateway.handleConnection(client, req);
    await gateway.handleSubscribe(client, { channel: 'dashboard' });

    expect(client.send).toHaveBeenCalledWith(
      JSON.stringify({ event: 'error', data: { message: 'Authenticate before subscribing' } }),
    );
  });

  it('should allow subscribe to global channel after auth', async () => {
    const client = mockClient();
    const req = mockReq('/events');
    jwtService.verify.mockReturnValue({ sub: 'user-1' });

    gateway.handleConnection(client, req);
    await gateway.handleAuth(client, { token: 'valid-jwt' });
    await gateway.handleSubscribe(client, { channel: 'dashboard' });

    // Should not get an error — the auth ok message is the only send
    expect(client.send).toHaveBeenCalledTimes(1); // only the auth ok
  });

  it('should allow subscribe to the authenticated user channel', async () => {
    const client = mockClient();
    const req = mockReq('/events');
    jwtService.verify.mockReturnValue({ sub: 'user-1' });

    gateway.handleConnection(client, req);
    await gateway.handleAuth(client, { token: 'valid-jwt' });
    await gateway.handleSubscribe(client, { channel: 'user:user-1' });

    expect(client.send).toHaveBeenCalledTimes(1);
  });

  it('should reject subscribe to another user channel', async () => {
    const client = mockClient();
    const req = mockReq('/events');
    jwtService.verify.mockReturnValue({ sub: 'user-1' });

    gateway.handleConnection(client, req);
    await gateway.handleAuth(client, { token: 'valid-jwt' });
    await gateway.handleSubscribe(client, { channel: 'user:user-2' });

    expect(client.send).toHaveBeenCalledWith(
      JSON.stringify({
        event: 'error',
        data: { message: 'Access denied for channel: user:user-2' },
      }),
    );
  });

  it('should reject auth message without token', async () => {
    const client = mockClient();
    const req = mockReq('/events');

    gateway.handleConnection(client, req);
    await gateway.handleAuth(client, { token: '' });

    expect(client.send).toHaveBeenCalledWith(
      JSON.stringify({ event: 'auth', data: { ok: false, reason: 'Token required' } }),
    );
    expect(client.close).toHaveBeenCalledWith(4401, 'Unauthorized');
  });
});
