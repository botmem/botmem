/**
 * Shared types for the bridge-owned local FTS5 search index.
 *
 * The index unifies records from local Apple sources (Contacts, iMessage) and,
 * when present, the WhatsApp desktop database into one searchable store so the
 * Botmem server can route live search to this Mac with zero server-side storage.
 */

/** Internal source identifier used inside the index (NOT the wire connectorType). */
export type SourceName = 'imessage' | 'whatsapp' | 'contacts';

/** A normalized record produced by a source adapter, ready to index. */
export interface IndexRecord {
  /** Stable id within the source (rowid, account-scoped id, etc.). */
  sourceId: string | number;
  /** Conversation/thread identifier (chat jid, chat identifier). Empty for contacts. */
  threadId?: string;
  /** Human-readable thread title (chat name). */
  threadTitle?: string;
  /** Display name of the sender (or the contact's name for contact records). */
  senderName?: string;
  /** Durable identifier of the sender (handle, jid). Empty when unknown. */
  senderId?: string;
  /** True when the local user authored the record. */
  isFromMe?: boolean;
  /** Event time in unix SECONDS (0 when unknown, e.g. contacts). */
  ts?: number;
  /** Indexed body text. */
  text: string;
  /** Opaque media descriptors (paths/thumbs); never message bodies. */
  media?: unknown[];
}

/** Source-state row mirrored from the index, used by `bridge.status`. */
export interface SourceState {
  source: SourceName;
  count: number;
  /** Epoch milliseconds of the last successful index for this source, or null. */
  lastIndexedAt: number | null;
}

/**
 * A search result item shaped to match what the Botmem server expects.
 * The server maps these directly into its SearchResult.
 */
export interface SearchItem {
  /** `${source}:${sourceId}` — unique within this bridge. */
  id: string;
  /** Wire connector type: imessage→'apple', whatsapp→'whatsapp', contacts→'contacts'. */
  connectorType: 'apple' | 'whatsapp' | 'contacts';
  /** 'message' for chat records, 'contact' for contact records. */
  sourceType: 'message' | 'contact';
  text: string;
  /** ISO 8601 string, or null when no event time (contacts). */
  eventTime: string | null;
  people: Array<{ name: string; durableId: string }>;
  threadTitle: string;
  isFromMe: boolean;
  media: unknown[];
  /** Higher = better (negated bm25 rank). */
  score: number;
}

/** Filters accepted by `search.query`. */
export interface SearchFilters {
  /** Internal source name (imessage|whatsapp|contacts). */
  source?: string;
  /** Wire source type (message|contact). */
  sourceType?: string;
  /** Wire connector type (apple|whatsapp|contacts); mapped back to source name. */
  connectorType?: string;
}

/** A read-only source adapter over a local app database. */
export interface SourceAdapter {
  readonly source: SourceName;
  /** Default on-disk path (or directory) for this source's database. */
  defaultDbPath(): string;
  /** Cheap presence/readability probe. Never throws. */
  detect(dbPath?: string): boolean;
  /**
   * Open the DB(s) read-only and yield normalized records. May be a sync
   * generator (Contacts/iMessage) or async (WhatsApp parses attached PDFs).
   */
  read(dbPath?: string): Generator<IndexRecord> | AsyncGenerator<IndexRecord>;
}
