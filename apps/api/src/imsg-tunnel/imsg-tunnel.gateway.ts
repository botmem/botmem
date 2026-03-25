/**
 * WebSocket gateway for iMessage bridge tunnel connections.
 *
 * Protocol:
 *   1. Bridge connects to /imsg-tunnel
 *   2. First message (JSON): { event: 'auth', data: { token, publicKey } }
 *   3. Server responds (JSON): { event: 'auth', data: { ok, publicKey } }
 *   4. All subsequent messages are encrypted binary (AES-256-GCM)
 */

import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, WebSocket } from 'ws';
import { Logger } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { ImsgTunnelService } from './imsg-tunnel.service';

interface ClientState {
  sessionId: string | null;
  authenticated: boolean;
  authTimer: ReturnType<typeof setTimeout>;
}

const AUTH_TIMEOUT_MS = 10_000;

@SkipThrottle()
@WebSocketGateway({ path: '/imsg-tunnel' })
export class ImsgTunnelGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(ImsgTunnelGateway.name);
  private clients = new Map<WebSocket, ClientState>();

  constructor(private tunnelService: ImsgTunnelService) {}

  handleConnection(client: WebSocket) {
    const authTimer = setTimeout(() => {
      const state = this.clients.get(client);
      if (state && !state.authenticated) {
        this.logger.debug('Bridge auth timeout — closing');
        client.close(4401, 'Auth timeout');
        this.clients.delete(client);
      }
    }, AUTH_TIMEOUT_MS);

    this.clients.set(client, {
      sessionId: null,
      authenticated: false,
      authTimer,
    });

    client.on('message', (raw: Buffer | string, _isBinary: boolean) => {
      const state = this.clients.get(client);
      if (!state) return;

      if (!state.authenticated) {
        // First message must be auth (JSON text)
        this.handleAuth(client, state, typeof raw === 'string' ? raw : raw.toString('utf-8'));
        return;
      }

      // Post-auth: all messages are encrypted binary
      if (state.sessionId) {
        const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        this.tunnelService.handleBridgeMessage(state.sessionId, buf);
      }
    });
  }

  handleDisconnect(client: WebSocket) {
    const state = this.clients.get(client);
    if (state) {
      clearTimeout(state.authTimer);
      if (state.sessionId) {
        this.tunnelService.handleDisconnect(state.sessionId);
      }
      this.clients.delete(client);
    }
  }

  private async handleAuth(client: WebSocket, state: ClientState, raw: string) {
    try {
      const msg = JSON.parse(raw) as {
        event: string;
        data: { token?: string; publicKey?: string };
      };

      if (msg.event !== 'auth' || !msg.data?.token || !msg.data?.publicKey) {
        this.sendJson(client, {
          event: 'auth',
          data: { ok: false, reason: 'Missing token or publicKey' },
        });
        client.close(4400, 'Bad auth message');
        return;
      }

      const result = await this.tunnelService.registerBridge(
        msg.data.token,
        client,
        msg.data.publicKey,
      );

      if (!result) {
        this.sendJson(client, {
          event: 'auth',
          data: { ok: false, reason: 'Invalid token' },
        });
        client.close(4401, 'Invalid token');
        return;
      }

      clearTimeout(state.authTimer);
      state.authenticated = true;
      state.sessionId = result.sessionId;

      this.sendJson(client, {
        event: 'auth',
        data: {
          ok: true,
          publicKey: result.serverPubKeyB64,
          sessionId: result.sessionId,
        },
      });

      this.logger.log(
        `Bridge authenticated: account=${result.accountId}, session=${result.sessionId}`,
      );
    } catch (err) {
      this.logger.warn(`Auth parse error: ${err instanceof Error ? err.message : err}`);
      this.sendJson(client, {
        event: 'auth',
        data: { ok: false, reason: 'Invalid message format' },
      });
      client.close(4400, 'Bad message');
    }
  }

  private sendJson(client: WebSocket, data: unknown) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  }
}
