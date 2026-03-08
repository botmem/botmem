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

  beforeEach(() => {
    jwtService = { verify: vi.fn() };
    configService = { jwtAccessSecret: 'test-secret' };
    eventsService = new EventsService();

    gateway = new EventsGateway(
      eventsService,
      jwtService as any,
      configService as any,
    );
  });

  function mockClient(): WebSocket {
    return {
      close: vi.fn(),
      readyState: WebSocket.OPEN,
      send: vi.fn(),
    } as unknown as WebSocket;
  }

  function mockReq(url: string): IncomingMessage {
    const socket = new Socket();
    const req = new IncomingMessage(socket);
    req.url = url;
    req.headers = { host: 'localhost:12412' };
    return req;
  }

  it('should reject connection without token (close 4401)', () => {
    const client = mockClient();
    const req = mockReq('/events');

    gateway.handleConnection(client, req);

    expect(client.close).toHaveBeenCalledWith(4401, 'Unauthorized');
  });

  it('should reject connection with invalid token (close 4401)', () => {
    const client = mockClient();
    const req = mockReq('/events?token=bad-token');
    jwtService.verify.mockImplementation(() => {
      throw new Error('Invalid token');
    });

    gateway.handleConnection(client, req);

    expect(client.close).toHaveBeenCalledWith(4401, 'Invalid token');
  });

  it('should accept connection with valid JWT', () => {
    const client = mockClient();
    const req = mockReq('/events?token=valid-jwt');
    jwtService.verify.mockReturnValue({ sub: 'user-1', email: 'test@test.com' });

    gateway.handleConnection(client, req);

    expect(client.close).not.toHaveBeenCalled();
    expect(jwtService.verify).toHaveBeenCalledWith('valid-jwt', {
      secret: 'test-secret',
    });
  });

  it('should verify token with jwtAccessSecret from config', () => {
    const client = mockClient();
    const req = mockReq('/events?token=my-token');
    jwtService.verify.mockReturnValue({ sub: 'user-1' });

    gateway.handleConnection(client, req);

    expect(jwtService.verify).toHaveBeenCalledWith('my-token', {
      secret: 'test-secret',
    });
  });
});
