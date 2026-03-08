import { Injectable } from '@nestjs/common';
import { EventEmitter } from 'events';

@Injectable()
export class EventsService extends EventEmitter {
  private debouncers = new Map<string, NodeJS.Timeout>();

  emitToChannel(channel: string, event: string, data: unknown) {
    this.emit('ws:broadcast', { channel, event, data });
  }

  /**
   * Debounced emission — collapses rapid-fire calls into a single WS broadcast.
   * `key` uniquely identifies the debounce group (e.g. "dashboard:stats").
   * `getter` is called when the debounce fires to fetch fresh data.
   */
  emitDebounced(key: string, channel: string, event: string, getter: () => Promise<unknown>, delayMs = 500) {
    const existing = this.debouncers.get(key);
    if (existing) clearTimeout(existing);
    this.debouncers.set(key, setTimeout(async () => {
      this.debouncers.delete(key);
      try {
        const data = await getter();
        this.emitToChannel(channel, event, data);
      } catch {
        // Non-fatal — stats emission failure shouldn't crash processors
      }
    }, delayMs));
  }
}
