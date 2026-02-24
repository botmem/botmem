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
  static DEBUG_SYNC_LIMIT = 50;

  abstract readonly manifest: ConnectorManifest;

  private _emitCount = 0;
  private _abortController: AbortController | null = null;

  abstract initiateAuth(config: Record<string, unknown>): Promise<AuthInitResult>;
  abstract completeAuth(params: Record<string, unknown>): Promise<AuthContext>;
  abstract validateAuth(auth: AuthContext): Promise<boolean>;
  abstract revokeAuth(auth: AuthContext): Promise<void>;
  abstract sync(ctx: SyncContext): Promise<SyncResult>;

  /** Wraps ctx with a limit-aware abort signal. Call this from the sync processor before sync(). */
  wrapSyncContext(ctx: SyncContext): SyncContext {
    if (BaseConnector.DEBUG_SYNC_LIMIT <= 0) return ctx;
    this._abortController = new AbortController();
    // If the parent signal aborts, propagate to our controller
    if (ctx.signal) {
      ctx.signal.addEventListener('abort', () => this._abortController?.abort(), { once: true });
    }
    return { ...ctx, signal: this._abortController.signal };
  }

  emitData(event: ConnectorDataEvent): boolean {
    if (BaseConnector.DEBUG_SYNC_LIMIT > 0 && this._emitCount >= BaseConnector.DEBUG_SYNC_LIMIT) {
      if (this._emitCount === BaseConnector.DEBUG_SYNC_LIMIT) {
        this.log('warn', `DEBUG_SYNC_LIMIT reached (${BaseConnector.DEBUG_SYNC_LIMIT}), stopping sync`);
        this._abortController?.abort();
      }
      this._emitCount++;
      return false;
    }
    this._emitCount++;
    return this.emit('data', event);
  }

  get isLimitReached(): boolean {
    return BaseConnector.DEBUG_SYNC_LIMIT > 0 && this._emitCount >= BaseConnector.DEBUG_SYNC_LIMIT;
  }

  resetSyncLimit(): void {
    this._emitCount = 0;
    this._abortController = null;
  }

  emitProgress(event: ProgressEvent): boolean {
    return this.emit('progress', event);
  }

  protected log(level: LogEvent['level'], message: string): void {
    this.emit('log', { level, message });
  }
}
