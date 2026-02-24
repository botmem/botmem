import { describe, it, expect, vi } from 'vitest';
import { EventsService } from '../events.service';

describe('EventsService', () => {
  it('emitToChannel emits ws:broadcast event', () => {
    const service = new EventsService();
    const listener = vi.fn();
    service.on('ws:broadcast', listener);

    service.emitToChannel('job:j1', 'job:progress', { progress: 50 });

    expect(listener).toHaveBeenCalledWith({
      channel: 'job:j1',
      event: 'job:progress',
      data: { progress: 50 },
    });
  });

  it('emitToChannel works with different channels', () => {
    const service = new EventsService();
    const listener = vi.fn();
    service.on('ws:broadcast', listener);

    service.emitToChannel('logs', 'log', { level: 'info', message: 'test' });

    expect(listener).toHaveBeenCalledWith({
      channel: 'logs',
      event: 'log',
      data: { level: 'info', message: 'test' },
    });
  });

  it('extends EventEmitter', () => {
    const service = new EventsService();
    expect(typeof service.on).toBe('function');
    expect(typeof service.emit).toBe('function');
  });
});
