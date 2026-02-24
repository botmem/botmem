import type { AuthContext, ConnectorDataEvent, SyncContext, ConnectorLogger } from './types.js';
import { BaseConnector } from './base.js';

export class TestHarness {
  private events: ConnectorDataEvent[] = [];
  private logs: Array<{ level: string; message: string }> = [];

  constructor(private connector: BaseConnector) {
    connector.on('data', (event) => this.events.push(event));
    connector.on('log', (log) => this.logs.push(log));
  }

  async testAuth(config: Record<string, unknown>): Promise<AuthContext> {
    const result = await this.connector.initiateAuth(config);
    if (result.type === 'complete') return result.auth;
    throw new Error(`Auth flow requires ${result.type}, cannot auto-complete in test harness`);
  }

  async testSync(auth: AuthContext, cursor: string | null = null): Promise<{
    events: ConnectorDataEvent[];
    logs: Array<{ level: string; message: string }>;
  }> {
    this.events = [];
    this.logs = [];

    const logger: ConnectorLogger = {
      info: (msg) => this.logs.push({ level: 'info', message: msg }),
      warn: (msg) => this.logs.push({ level: 'warn', message: msg }),
      error: (msg) => this.logs.push({ level: 'error', message: msg }),
      debug: (msg) => this.logs.push({ level: 'debug', message: msg }),
    };

    const ctx: SyncContext = {
      accountId: 'test-account',
      auth,
      cursor,
      jobId: 'test-job',
      logger,
      signal: AbortSignal.timeout(30_000),
    };

    await this.connector.sync(ctx);
    return { events: [...this.events], logs: [...this.logs] };
  }
}
