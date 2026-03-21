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
  CleanResult,
  EmbedResult,
  EnrichResult,
  PipelineContext,
} from './types.js';
import { detectNoiseReason } from './noise-filter.js';

export abstract class BaseConnector extends EventEmitter {
  /** Set at startup from SYNC_DEBUG_LIMIT env var. 0 = disabled (unlimited). */
  static DEBUG_SYNC_LIMIT = 0;

  abstract readonly manifest: ConnectorManifest;

  private _emitCount = 0;
  private _filteredCount = 0;
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

  /**
   * Check if an event should be emitted (not noise).
   * Returns true if the event is clean, false if it was filtered as noise.
   */
  shouldEmit(event: ConnectorDataEvent): boolean {
    const text = event.content?.text || '';
    const metadata = event.content?.metadata || {};

    // Skip noise filtering for contact-type events — always keep those
    if (event.sourceType === 'contact' || metadata.type === 'contact') return true;

    const reason = detectNoiseReason(text, metadata);
    if (reason) {
      this._filteredCount++;
      this.log('debug', `Noise filtered (${reason}): ${text.slice(0, 80)}...`);
      return false;
    }
    return true;
  }

  emitData(event: ConnectorDataEvent): boolean {
    if (BaseConnector.DEBUG_SYNC_LIMIT > 0 && this._emitCount >= BaseConnector.DEBUG_SYNC_LIMIT) {
      if (this._emitCount === BaseConnector.DEBUG_SYNC_LIMIT) {
        this.log(
          'warn',
          `DEBUG_SYNC_LIMIT reached (${BaseConnector.DEBUG_SYNC_LIMIT}), stopping sync`,
        );
        this._abortController?.abort();
      }
      this._emitCount++;
      return false;
    }

    // Apply noise filtering before emitting
    if (!this.shouldEmit(event)) {
      return false;
    }

    this._emitCount++;
    return this.emit('data', event);
  }

  get isLimitReached(): boolean {
    return BaseConnector.DEBUG_SYNC_LIMIT > 0 && this._emitCount >= BaseConnector.DEBUG_SYNC_LIMIT;
  }

  /** Number of events filtered as noise during this sync */
  get filteredCount(): number {
    return this._filteredCount;
  }

  resetSyncLimit(): void {
    this._emitCount = 0;
    this._filteredCount = 0;
    this._abortController = null;
  }

  emitProgress(event: ProgressEvent): boolean {
    return this.emit('progress', { ...event, filteredCount: this._filteredCount });
  }

  protected log(level: LogEvent['level'], message: string): void {
    this.emit('log', { level, message });
  }

  /** Clean raw event text. Default: strip HTML + collapse whitespace. */
  clean(event: ConnectorDataEvent, _ctx: PipelineContext): CleanResult | Promise<CleanResult> {
    let text = event.content?.text || '';
    if (/<(?:html|!DOCTYPE|div)/i.test(text)) {
      text = text
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'");
    }
    // Strip invisible Unicode: zero-width joiners/spaces, soft hyphens, etc.
    text = text.replace(
      // eslint-disable-next-line no-misleading-character-class -- intentionally matching combining/invisible codepoints
      /[\u200B-\u200D\u2060\uFEFF\u00AD\u034F\u061C\u180E\u2000-\u200F\u202A-\u202E\u2066-\u2069]/gu,
      '',
    );
    // Strip tracking/encoded URLs (long URL-encoded strings)
    text = text.replace(/https?:\/\/\S*(?:click\?upn=|ls\/click|url\d+\.\S+\/ls\/)\S*/gi, '');
    // Collapse whitespace
    text = text.replace(/\s{2,}/g, ' ').trim();
    return { text };
  }

  /** Prepare embedding data. Default: return text + participants as person entities. */
  embed(
    event: ConnectorDataEvent,
    cleanedText: string,
    _ctx: PipelineContext,
  ): EmbedResult | Promise<EmbedResult> {
    const entities = (event.content?.participants || []).map((p) => ({
      type: 'person',
      id: p,
      role: 'participant',
    }));
    return { text: cleanedText, entities };
  }

  /** Enrich a memory. Default: no-op. */
  enrich(_memoryId: string, _ctx: PipelineContext): EnrichResult | Promise<EnrichResult> {
    return {};
  }

  /** Extract file content. Default: null (no file handling). */
  extractFile(_fileUrl: string, _mimetype: string, _auth: AuthContext): Promise<string | null> {
    return Promise.resolve(null);
  }
}
