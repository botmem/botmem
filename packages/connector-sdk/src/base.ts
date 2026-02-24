import { EventEmitter } from 'events';
import type {
  ConnectorManifest,
  AuthContext,
  AuthInitResult,
  SyncContext,
  SyncResult,
  ConnectorDataEvent,
  ProgressEvent,
  LogEvent,
} from './types.js';

export abstract class BaseConnector extends EventEmitter {
  abstract readonly manifest: ConnectorManifest;

  abstract initiateAuth(config: Record<string, unknown>): Promise<AuthInitResult>;
  abstract completeAuth(params: Record<string, unknown>): Promise<AuthContext>;
  abstract validateAuth(auth: AuthContext): Promise<boolean>;
  abstract revokeAuth(auth: AuthContext): Promise<void>;
  abstract sync(ctx: SyncContext): Promise<SyncResult>;

  emitData(event: ConnectorDataEvent): boolean {
    return this.emit('data', event);
  }

  emitProgress(event: ProgressEvent): boolean {
    return this.emit('progress', event);
  }

  protected log(level: LogEvent['level'], message: string): void {
    this.emit('log', { level, message });
  }
}
