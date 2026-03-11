import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'async_hooks';
import { randomBytes } from 'crypto';

export interface TraceStore {
  traceId: string;
  spanId: string;
}

/** Generate a W3C-format trace ID (32 hex chars) */
export function generateTraceId(): string {
  return randomBytes(16).toString('hex');
}

/** Generate a W3C-format span ID (16 hex chars) */
export function generateSpanId(): string {
  return randomBytes(8).toString('hex');
}

@Injectable()
export class TraceContext {
  private readonly storage = new AsyncLocalStorage<TraceStore>();

  /** Run fn with trace context set */
  run<T>(ctx: TraceStore, fn: () => T): T {
    return this.storage.run(ctx, fn);
  }

  /** Get current trace context — returns undefined outside a traced scope */
  current(): TraceStore | undefined {
    return this.storage.getStore();
  }
}
