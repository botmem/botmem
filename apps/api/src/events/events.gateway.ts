import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayInit,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
} from '@nestjs/websockets';
import { Server, WebSocket } from 'ws';
import { JwtService } from '@nestjs/jwt';
import { IncomingMessage } from 'http';
import { eq } from 'drizzle-orm';
import { EventsService } from './events.service';
import { ConfigService } from '../config/config.service';
import { DbService } from '../db/db.service';
import * as schema from '../db/schema';
import { SkipThrottle } from '@nestjs/throttler';

interface ClientState {
  userId: string | null;
  channels: Set<string>;
}

@SkipThrottle()
@WebSocketGateway({ path: '/events' })
export class EventsGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  private clients = new Map<WebSocket, ClientState>();

  constructor(
    private events: EventsService,
    private jwtService: JwtService,
    private config: ConfigService,
    private dbService: DbService,
  ) {}

  afterInit() {
    this.events.on('ws:broadcast', ({ channel, event, data }) => {
      try {
        const message = JSON.stringify({ channel, event, data });
        for (const [client, state] of this.clients) {
          if (state.channels.has(channel) && client.readyState === WebSocket.OPEN) {
            client.send(message);
          }
        }
      } catch {
        // Circular reference or non-serializable object in data
        // Send a sanitized version with error message
        const sanitized = {
          channel,
          event,
          data: {
            _error: 'Data contains non-serializable content',
            _type: typeof data,
          },
        };
        const message = JSON.stringify(sanitized);
        for (const [client, state] of this.clients) {
          if (state.channels.has(channel) && client.readyState === WebSocket.OPEN) {
            client.send(message);
          }
        }
      }
    });
  }

  handleConnection(client: WebSocket, _req: IncomingMessage) {
    // Accept the connection but mark as unauthenticated.
    // Client must send an "auth" message with JWT before subscribing.
    this.clients.set(client, { userId: null, channels: new Set() });
  }

  handleDisconnect(client: WebSocket) {
    this.clients.delete(client);
  }

  @SubscribeMessage('auth')
  handleAuth(client: WebSocket, data: { token: string }) {
    const state = this.clients.get(client);
    if (!state) return;

    if (!data?.token) {
      client.send(JSON.stringify({ event: 'auth', data: { ok: false, reason: 'Token required' } }));
      client.close(4401, 'Unauthorized');
      return;
    }

    try {
      const payload = this.jwtService.verify(data.token, {
        secret: this.config.jwtAccessSecret,
      });
      state.userId = payload.sub;
      client.send(JSON.stringify({ event: 'auth', data: { ok: true } }));
    } catch {
      client.send(JSON.stringify({ event: 'auth', data: { ok: false, reason: 'Invalid token' } }));
      client.close(4401, 'Invalid token');
    }
  }

  @SubscribeMessage('subscribe')
  async handleSubscribe(client: WebSocket, data: { channel: string }) {
    const state = this.clients.get(client);
    if (!state || !state.userId) {
      client.send(
        JSON.stringify({
          event: 'error',
          data: { message: 'Authenticate before subscribing' },
        }),
      );
      return;
    }

    const channel = data.channel;

    // Authorize channel access based on resource ownership
    const authorized = await this.authorizeChannel(state.userId, channel);
    if (!authorized) {
      client.send(
        JSON.stringify({
          event: 'error',
          data: { message: `Access denied for channel: ${channel}` },
        }),
      );
      return;
    }

    state.channels.add(channel);
  }

  @SubscribeMessage('unsubscribe')
  handleUnsubscribe(client: WebSocket, data: { channel: string }) {
    const state = this.clients.get(client);
    if (!state) return;
    state.channels.delete(data.channel);
  }

  /**
   * Verify the user owns the resource referenced by the channel name.
   * Channel patterns:
   *   job:<jobId>      — job must belong to an account the user owns
   *   account:<id>     — account must belong to the user
   *   auth:<sessionId> — auth sessions are ephemeral, allow for authenticated users
   *   dashboard, logs, memories, notifications — user-scoped global channels, always allowed
   */
  private async authorizeChannel(userId: string, channel: string): Promise<boolean> {
    if (channel.startsWith('job:')) {
      const jobId = channel.slice(4);
      const rows = await this.dbService.db
        .select({ userId: schema.accounts.userId })
        .from(schema.jobs)
        .innerJoin(schema.accounts, eq(schema.jobs.accountId, schema.accounts.id))
        .where(eq(schema.jobs.id, jobId))
        .limit(1);
      return rows.length > 0 && rows[0].userId === userId;
    }

    if (channel.startsWith('account:')) {
      const accountId = channel.slice(8);
      const rows = await this.dbService.db
        .select({ userId: schema.accounts.userId })
        .from(schema.accounts)
        .where(eq(schema.accounts.id, accountId))
        .limit(1);
      return rows.length > 0 && rows[0].userId === userId;
    }

    // Auth session channels (e.g. auth:session-xxx) — allowed for any authenticated user
    if (channel.startsWith('auth:')) {
      return true;
    }

    // Global channels — allowed for any authenticated user
    const globalChannels = ['dashboard', 'logs', 'memories', 'notifications'];
    if (globalChannels.includes(channel)) {
      return true;
    }

    // Unknown channel pattern — deny by default
    return false;
  }
}
