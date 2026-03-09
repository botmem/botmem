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
import { EventsService } from './events.service';
import { ConfigService } from '../config/config.service';
import { SkipThrottle } from '@nestjs/throttler';

@SkipThrottle()
@WebSocketGateway({ path: '/events' })
export class EventsGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  private subscriptions = new Map<WebSocket, Set<string>>();

  constructor(
    private events: EventsService,
    private jwtService: JwtService,
    private config: ConfigService,
  ) {}

  afterInit() {
    this.events.on('ws:broadcast', ({ channel, event, data }) => {
      try {
        const message = JSON.stringify({ channel, event, data });
        for (const [client, channels] of this.subscriptions) {
          if (channels.has(channel) && client.readyState === WebSocket.OPEN) {
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
        for (const [client, channels] of this.subscriptions) {
          if (channels.has(channel) && client.readyState === WebSocket.OPEN) {
            client.send(message);
          }
        }
      }
    });
  }

  handleConnection(client: WebSocket, req: IncomingMessage) {
    const url = new URL(req.url!, `http://${req.headers.host}`);
    const token = url.searchParams.get('token');

    if (!token) {
      client.close(4401, 'Unauthorized');
      return;
    }

    try {
      this.jwtService.verify(token, { secret: this.config.jwtAccessSecret });
      this.subscriptions.set(client, new Set());
    } catch {
      client.close(4401, 'Invalid token');
      return;
    }
  }

  handleDisconnect(client: WebSocket) {
    this.subscriptions.delete(client);
  }

  @SubscribeMessage('subscribe')
  handleSubscribe(client: WebSocket, data: { channel: string }) {
    const channels = this.subscriptions.get(client);
    if (channels) channels.add(data.channel);
  }

  @SubscribeMessage('unsubscribe')
  handleUnsubscribe(client: WebSocket, data: { channel: string }) {
    const channels = this.subscriptions.get(client);
    if (channels) channels.delete(data.channel);
  }
}
