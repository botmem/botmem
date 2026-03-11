import { ConsoleLogger, Injectable } from '@nestjs/common';
import { PostHog } from 'posthog-node';
import type { TraceContext } from '../tracing/trace.context';

const LEVEL_PRIORITY: Record<string, number> = {
  error: 0,
  warn: 1,
  log: 2,
  debug: 3,
  verbose: 4,
};

/**
 * NestJS logger that keeps console output AND sends every log to PostHog
 * as `$log_entry` events under a configurable service name.
 *
 * Set via `app.useLogger()` after the NestJS app is created.
 */
@Injectable()
export class PostHogLoggerService extends ConsoleLogger {
  private ph: PostHog | null = null;
  private serviceName = 'botmem-api';
  private minLevel = 2;
  private traceContext: TraceContext | null = null;

  /** Wire up TraceContext after DI container is ready (logger is created before DI). */
  setTraceContext(tc: TraceContext) {
    this.traceContext = tc;
  }

  /** Call once after construction to wire up PostHog. */
  init(opts: { apiKey: string; host: string; serviceName?: string; minLevel?: string }) {
    if (opts.apiKey) {
      this.ph = new PostHog(opts.apiKey, { host: opts.host });
    }
    this.serviceName = opts.serviceName || 'botmem-api';
    this.minLevel = LEVEL_PRIORITY[opts.minLevel || 'log'] ?? 2;
  }

  private tracePrefix(): string {
    const ctx = this.traceContext?.current();
    if (!ctx) return '';
    return `[trace=${ctx.traceId.slice(0, 12)}] `;
  }

  override log(message: unknown, context?: string): void {
    const msg = typeof message === 'string' ? this.tracePrefix() + message : message;
    super.log(msg, context);
    this.send('info', message, context);
  }

  override error(message: unknown, stackOrContext?: string, context?: string): void {
    const msg = typeof message === 'string' ? this.tracePrefix() + message : message;
    super.error(msg, stackOrContext, context);
    this.send('error', message, context || stackOrContext, stackOrContext);
  }

  override warn(message: unknown, context?: string): void {
    const msg = typeof message === 'string' ? this.tracePrefix() + message : message;
    super.warn(msg, context);
    this.send('warn', message, context);
  }

  override debug(message: unknown, context?: string): void {
    const msg = typeof message === 'string' ? this.tracePrefix() + message : message;
    super.debug(msg, context);
    this.send('debug', message, context);
  }

  override verbose(message: unknown, context?: string): void {
    const msg = typeof message === 'string' ? this.tracePrefix() + message : message;
    super.verbose(msg, context);
    this.send('verbose', message, context);
  }

  async shutdown(): Promise<void> {
    await this.ph?.shutdown();
  }

  private send(level: string, message: unknown, context?: string, stack?: string) {
    if (!this.ph) return;
    const priority = LEVEL_PRIORITY[level === 'info' ? 'log' : level] ?? 2;
    if (priority > this.minLevel) return;

    const msg = typeof message === 'string' ? message : JSON.stringify(message);
    const trace = this.traceContext?.current();

    this.ph.capture({
      distinctId: this.serviceName,
      event: '$log_entry',
      properties: {
        $log_level: level,
        $log_message: msg,
        $log_service_name: this.serviceName,
        $log_context: context,
        ...(stack && level === 'error' ? { $log_stack: stack } : {}),
        ...(trace ? { $log_trace_id: trace.traceId, $log_span_id: trace.spanId } : {}),
        $current_url: `service://${this.serviceName}`,
      },
    });
  }
}
