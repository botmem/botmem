import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, WebSocket } from 'ws';
import { JwtService } from '@nestjs/jwt';
import { IncomingMessage } from 'http';
import { Inject, Logger, forwardRef } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { ConfigService } from '../config/config.service';
import { ConnectorsService } from '../connectors/connectors.service';
import { AuthService } from '../auth/auth.service';
import { WaTunnelService } from './wa-tunnel.service';
import type { WhatsAppConnector } from '@botmem/connector-whatsapp';

interface TunnelClientState {
  userId: string | null;
  sessionId: string | null;
  authenticated: boolean;
}

@SkipThrottle()
@WebSocketGateway({ path: '/wa-tunnel' })
export class WaTunnelGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(WaTunnelGateway.name);
  private clients = new Map<WebSocket, TunnelClientState>();

  constructor(
    private jwtService: JwtService,
    private config: ConfigService,
    private tunnelService: WaTunnelService,
    private connectors: ConnectorsService,
    @Inject(forwardRef(() => AuthService)) private authService: AuthService,
  ) {}

  handleConnection(client: WebSocket, _req: IncomingMessage) {
    this.clients.set(client, { userId: null, sessionId: null, authenticated: false });

    const authTimeout = setTimeout(() => {
      const state = this.clients.get(client);
      if (state && !state.authenticated) {
        client.close(4401, 'Auth timeout');
        this.clients.delete(client);
      }
    }, 10_000);

    client.on('message', (raw: Buffer, isBinary: boolean) => {
      const state = this.clients.get(client);
      if (!state) return;

      // Binary frames after auth → forward to Baileys relay
      if (isBinary && state.authenticated && state.sessionId) {
        this.tunnelService.handleBrowserFrame(state.sessionId, Buffer.from(raw));
        return;
      }

      // Text (JSON) messages
      try {
        const str = typeof raw === 'string' ? raw : raw.toString();
        const msg = JSON.parse(str);

        // Auth message
        if (msg.event === 'auth' && msg.data?.token) {
          try {
            const payload = this.jwtService.verify(msg.data.token, {
              secret: this.config.jwtAccessSecret,
            });
            state.userId = payload.sub;
            state.authenticated = true;
            clearTimeout(authTimeout);
            client.send(JSON.stringify({ event: 'auth', data: { ok: true } }));

            // If sessionId is provided, attach to existing session
            if (msg.data.sessionId) {
              const session = this.tunnelService.getSession(msg.data.sessionId);
              if (session && session.userId === state.userId) {
                state.sessionId = msg.data.sessionId;
                this.tunnelService.attachBrowser(msg.data.sessionId, client);
                client.send(
                  JSON.stringify({
                    event: 'tunnel:attached',
                    data: { sessionId: state.sessionId },
                  }),
                );
              } else {
                client.send(
                  JSON.stringify({
                    event: 'tunnel:error',
                    data: { message: 'Session not found or access denied' },
                  }),
                );
              }
            }
          } catch {
            client.send(
              JSON.stringify({ event: 'auth', data: { ok: false, reason: 'Invalid token' } }),
            );
            client.close(4401, 'Invalid token');
          }
          return;
        }

        if (!state.authenticated) {
          client.send(JSON.stringify({ event: 'error', data: { message: 'Not authenticated' } }));
          return;
        }

        // Create a new tunnel session
        if (msg.event === 'create-session') {
          this.handleCreateSession(client, state).catch((err) => {
            this.logger.error(`create-session failed: ${err.message}`);
            this.sendJson(client, {
              event: 'error',
              data: { message: 'Failed to create session' },
            });
          });
          return;
        }

        // Start QR auth through the tunnel
        if (msg.event === 'start-qr-auth' && state.sessionId) {
          this.handleStartQrAuth(client, state).catch((err) => {
            this.logger.error(`start-qr-auth failed: ${err.message}`);
            this.sendJson(client, { event: 'auth:error', data: { error: err.message } });
          });
          return;
        }

        // Attach to session (can happen after auth)
        if (msg.event === 'attach' && msg.data?.sessionId) {
          const session = this.tunnelService.getSession(msg.data.sessionId);
          if (session && session.userId === state.userId) {
            state.sessionId = msg.data.sessionId;
            this.tunnelService.attachBrowser(msg.data.sessionId, client);
            client.send(
              JSON.stringify({ event: 'tunnel:attached', data: { sessionId: state.sessionId } }),
            );
          } else {
            client.send(
              JSON.stringify({ event: 'tunnel:error', data: { message: 'Session not found' } }),
            );
          }
          return;
        }

        // Control messages (wa-ready, wa-closed, wa-error)
        if (state.sessionId && msg.type) {
          this.tunnelService.handleBrowserControl(state.sessionId, msg);
          return;
        }

        // Auth state responses from browser IndexedDB
        if (msg.type?.startsWith('auth-state:') && msg.type.endsWith(':response')) {
          // Handled by the promise-based handler in WaTunnelService
          return;
        }
      } catch {
        // Not JSON — ignore
      }
    });
  }

  handleDisconnect(client: WebSocket) {
    this.clients.delete(client);
  }

  private async handleCreateSession(client: WebSocket, state: TunnelClientState) {
    const { sessionId } = await this.tunnelService.createSession(state.userId!);
    state.sessionId = sessionId;
    this.tunnelService.attachBrowser(sessionId, client);
    this.sendJson(client, { event: 'session:created', data: { sessionId } });
  }

  private async handleStartQrAuth(client: WebSocket, state: TunnelClientState) {
    const session = this.tunnelService.getSession(state.sessionId!);
    if (!session) {
      this.sendJson(client, { event: 'auth:error', data: { error: 'Session not found' } });
      return;
    }

    const relayUrl = this.tunnelService.getRelayUrl(state.sessionId!);
    if (!relayUrl) {
      this.sendJson(client, { event: 'auth:error', data: { error: 'Relay not available' } });
      return;
    }

    const authStateTransport = {
      get: (requestId: string, file: string) =>
        this.tunnelService.handleAuthStateRequest(state.sessionId!, requestId, 'get', file),
      set: (requestId: string, file: string, data: unknown) =>
        this.tunnelService.handleAuthStateRequest(
          state.sessionId!,
          requestId,
          'set',
          file,
          data,
        ) as Promise<void>,
    };

    const connector = this.connectors.get('whatsapp') as WhatsAppConnector;
    let authCompleted = false;

    await connector.initiateTunnelAuth(relayUrl, authStateTransport, {
      onQrCode: (qrDataUrl: string) => {
        if (!authCompleted) {
          this.sendJson(client, { event: 'qr:update', data: { qrData: qrDataUrl } });
        }
      },
      onConnected: async (auth, _sock) => {
        this.sendJson(client, {
          event: 'auth:status',
          data: { status: 'connecting', step: 'Device linked, setting up...' },
        });

        try {
          const authContext = {
            ...auth,
            raw: { ...(auth.raw || {}), tunnelMode: true },
          };
          const account = await this.authService.completeTunnelAuth(
            'whatsapp',
            authContext as Record<string, unknown>,
            state.userId!,
          );
          authCompleted = true;
          this.sendJson(client, {
            event: 'auth:status',
            data: {
              status: 'success',
              accountId: account.id,
              identifier: account.identifier,
            },
          });
        } catch (err) {
          this.logger.error(
            `Tunnel QR auth account creation failed: ${err instanceof Error ? err.message : err}`,
          );
          this.sendJson(client, {
            event: 'auth:error',
            data: { error: err instanceof Error ? err.message : 'Account creation failed' },
          });
        }
      },
      onError: (error: Error) => {
        if (!authCompleted) {
          this.sendJson(client, { event: 'auth:error', data: { error: error.message } });
        }
      },
    });
  }

  private sendJson(client: WebSocket, data: unknown) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  }
}
