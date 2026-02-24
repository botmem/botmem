import { Injectable } from '@nestjs/common';
import { EventEmitter } from 'events';

@Injectable()
export class EventsService extends EventEmitter {
  emitToChannel(channel: string, event: string, data: unknown) {
    this.emit('ws:broadcast', { channel, event, data });
  }
}
