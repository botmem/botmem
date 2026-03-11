import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventsGateway } from '../events.gateway';
import { EventsService } from '../events.service';
import { WebSocket } from 'ws';
import { IncomingMessage } from 'http';
import { Socket } from 'net';

describe('EventsGateway WebSocket Auth', () => {
  let gateway: EventsGateway;
  let jwtService: { verify: ReturnType<typeof vi.fn> };
  let configService: { jwtAccessSecret: string };
  let eventsService: EventsService;
  let dbService: { db: any };

  beforeEach(() => {
    jwtService = { verify: vi.fn() };
    configService = { jwtAccessSecret: 'test-secret' };
    eventsService = new EventsService();
    dbService = { db: {} };

    gateway = new EventsGateway(
      eventsService,
      jwtService as any,
      configService as any,
      dbService as any,
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

  it('should reject auth message with invalid token', () => {
    const client = mockClient();
    const req = mockReq('/events');
    jwtService.verify.mockImplementation(() => {
      throw new Error('Invalid token');
    });

    gateway.handleConnection(client, req);
    gateway.handleAuth(client, { token: 'bad-token' });

    expect(client.send).toHaveBeenCalledWith(
      JSON.stringify({ event: 'auth', data: { ok: false, reason: 'Invalid token' } }),
    );
    expect(client.close).toHaveBeenCalledWith(4401, 'Invalid token');
  });

  it('should authenticate client with valid JWT', () => {
    const client = mockClient();
    const req = mockReq('/events');
    jwtService.verify.mockReturnValue({ sub: 'user-1', email: 'test@test.com' });

    gateway.handleConnection(client, req);
    gateway.handleAuth(client, { token: 'valid-jwt' });

    expect(client.close).not.toHaveBeenCalled();
    expect(client.send).toHaveBeenCalledWith(JSON.stringify({ event: 'auth', data: { ok: true } }));
    expect(jwtService.verify).toHaveBeenCalledWith('valid-jwt', {
      secret: 'test-secret',
    });
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
    gateway.handleAuth(client, { token: 'valid-jwt' });
    await gateway.handleSubscribe(client, { channel: 'dashboard' });

    // Should not get an error — the auth ok message is the only send
    expect(client.send).toHaveBeenCalledTimes(1); // only the auth ok
  });

  it('should reject auth message without token', () => {
    const client = mockClient();
    const req = mockReq('/events');

    gateway.handleConnection(client, req);
    gateway.handleAuth(client, { token: '' });

    expect(client.send).toHaveBeenCalledWith(
      JSON.stringify({ event: 'auth', data: { ok: false, reason: 'Token required' } }),
    );
    expect(client.close).toHaveBeenCalledWith(4401, 'Unauthorized');
  });
});
