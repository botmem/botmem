import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayInit,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
} from '@nestjs/websockets';
import { Server, WebSocket } from 'ws';
import { EventsService } from './events.service';

@WebSocketGateway({ path: '/events' })
export class EventsGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  private subscriptions = new Map<WebSocket, Set<string>>();

  constructor(private events: EventsService) {}

  afterInit() {
    this.events.on('ws:broadcast', ({ channel, event, data }) => {
      const message = JSON.stringify({ channel, event, data });
      for (const [client, channels] of this.subscriptions) {
        if (channels.has(channel) && client.readyState === WebSocket.OPEN) {
          client.send(message);
        }
      }
    });
  }

  handleConnection(client: WebSocket) {
    this.subscriptions.set(client, new Set());
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
