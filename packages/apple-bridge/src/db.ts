/**
 * SQLite query layer for ~/Library/Messages/chat.db.
 *
 * Reads the iMessage database in read-only mode and returns data
 * matching the JSON-RPC types expected by the Botmem iMessage connector.
 *
 * Core Data timestamp conversion:
 *   macOS stores dates as nanoseconds since 2001-01-01T00:00:00Z.
 *   Unix epoch offset: 978307200 seconds.
 *   Formula: new Date((date / 1e9 + 978307200) * 1000)
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Database = require('better-sqlite3') as any;

// ── Types (match AppleClient interface) ──────────────────────────────────────

export interface Chat {
  id: number;
  name: string;
  identifier: string;
  guid?: string;
  service: string;
  last_message_at: string;
  participants?: string[];
  is_group?: boolean;
}

export interface Attachment {
  filename?: string;
  mime_type?: string;
  transfer_name?: string;
}

export interface Reaction {
  sender?: string;
  type?: string;
}

export interface Message {
  id: number;
  chat_id: number;
  guid: string;
  sender: string;
  is_from_me: boolean;
  text: string;
  created_at: string;
  attachments: Attachment[];
  reactions: Reaction[];
  chat_identifier: string;
  chat_name: string;
  participants: string[];
  is_group: boolean;
  reply_to_guid?: string;
}

// ── Constants ───────────────────────────────────────────────────────────────

/** Seconds between 2001-01-01 and 1970-01-01 (Unix epoch). */
const CORE_DATA_EPOCH_OFFSET = 978307200;

/** Convert Core Data nanosecond timestamp to ISO 8601 string. */
function coreDataToISO(nanos: number | null): string {
  if (!nanos || nanos === 0) return new Date(0).toISOString();
  const unixSeconds = nanos / 1_000_000_000 + CORE_DATA_EPOCH_OFFSET;
  return new Date(unixSeconds * 1000).toISOString();
}

// ── Database ────────────────────────────────────────────────────────────────

export class AppleMessagesDatabase {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private db: any;

  constructor(dbPath: string) {
    this.db = new Database(dbPath, { readonly: true, fileMustExist: true });
    // WAL mode for concurrent reads while Messages.app writes
    this.db.pragma('journal_mode = WAL');
  }

  close(): void {
    this.db.close();
  }

  /** List chats sorted by most recent message. */
  chatsList(limit?: number): Chat[] {
    const sql = `
      SELECT
        c.ROWID as id,
        COALESCE(c.display_name, '') as name,
        c.guid as identifier,
        c.guid,
        COALESCE(c.service_name, 'iMessage') as service,
        MAX(m.date) as last_message_date
      FROM chat c
      LEFT JOIN chat_message_join cmj ON cmj.chat_id = c.ROWID
      LEFT JOIN message m ON m.ROWID = cmj.message_id
      GROUP BY c.ROWID
      ORDER BY last_message_date DESC
      ${limit ? 'LIMIT ?' : ''}
    `;

    const rows = limit ? this.db.prepare(sql).all(limit) : this.db.prepare(sql).all();

    return (rows as Array<Record<string, unknown>>).map((row) => {
      const chatId = row.id as number;
      const participants = this.getChatParticipants(chatId);
      const isGroup = participants.length > 1;

      return {
        id: chatId,
        name: (row.name as string) || (isGroup ? 'Group Chat' : participants[0] || 'Unknown'),
        identifier: row.identifier as string,
        guid: row.guid as string,
        service: row.service as string,
        last_message_at: coreDataToISO(row.last_message_date as number | null),
        participants,
        is_group: isGroup,
      };
    });
  }

  /** Get message history for a chat with optional time-based pagination. */
  messagesHistory(
    chatId: number,
    opts?: { limit?: number; start?: string; end?: string },
  ): Message[] {
    // Get chat metadata once
    const chatMeta = this.getChatMeta(chatId);

    let sql = `
      SELECT
        m.ROWID as id,
        m.guid,
        m.text,
        m.attributedBody,
        m.date,
        m.is_from_me,
        m.cache_roomnames,
        m.associated_message_guid,
        m.associated_message_type,
        h.id as handle_id
      FROM message m
      JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
      LEFT JOIN handle h ON h.ROWID = m.handle_id
      WHERE cmj.chat_id = ?
    `;

    const params: unknown[] = [chatId];

    if (opts?.start) {
      const startNanos = isoToCoreData(opts.start);
      sql += ' AND m.date >= ?';
      params.push(startNanos);
    }

    if (opts?.end) {
      const endNanos = isoToCoreData(opts.end);
      sql += ' AND m.date <= ?';
      params.push(endNanos);
    }

    sql += ' ORDER BY m.date ASC';

    if (opts?.limit) {
      sql += ' LIMIT ?';
      params.push(opts.limit);
    }

    const rows = this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    const participants = this.getChatParticipants(chatId);
    const messageIds = rows.map((row) => row.id as number);
    const attachmentsByMessageId = this.getAttachmentsForMessages(messageIds);

    return rows.map((row) => {
      const msgId = row.id as number;
      const attachments = attachmentsByMessageId.get(msgId) || [];
      const text =
        (row.text as string) ||
        extractAttributedBodyText(row.attributedBody as Buffer | null | undefined) ||
        '';

      return {
        id: msgId,
        chat_id: chatId,
        guid: (row.guid as string) || `apple-msg-local-${msgId}`,
        sender: (row.handle_id as string) || '',
        is_from_me: (row.is_from_me as number) === 1,
        text,
        created_at: coreDataToISO(row.date as number | null),
        attachments,
        // Reactions are not used by the Botmem ingestion pipeline. Fetching them
        // per message requires an unindexed suffix LIKE scan over the message
        // table, which makes large chats time out.
        reactions: [],
        chat_identifier: chatMeta.identifier,
        chat_name: chatMeta.name,
        participants,
        is_group: participants.length > 1,
        reply_to_guid: (row.associated_message_guid as string) || undefined,
      };
    });
  }

  // ── Private helpers ─────────────────────────────────────────────────────

  private getChatParticipants(chatId: number): string[] {
    const sql = `
      SELECT h.id
      FROM chat_handle_join chj
      JOIN handle h ON h.ROWID = chj.handle_id
      WHERE chj.chat_id = ?
    `;
    const rows = this.db.prepare(sql).all(chatId) as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }

  private getChatMeta(chatId: number): { name: string; identifier: string } {
    const sql = `
      SELECT COALESCE(display_name, '') as name, guid as identifier
      FROM chat WHERE ROWID = ?
    `;
    const row = this.db.prepare(sql).get(chatId) as
      | { name: string; identifier: string }
      | undefined;
    return row || { name: 'Unknown', identifier: '' };
  }

  private getAttachmentsForMessages(messageIds: number[]): Map<number, Attachment[]> {
    const byMessageId = new Map<number, Attachment[]>();
    if (messageIds.length === 0) return byMessageId;

    const chunkSize = 900;
    for (let i = 0; i < messageIds.length; i += chunkSize) {
      const chunk = messageIds.slice(i, i + chunkSize);
      const placeholders = chunk.map(() => '?').join(',');
      const sql = `
        SELECT
          maj.message_id,
          a.filename,
          a.mime_type,
          a.transfer_name
        FROM message_attachment_join maj
        JOIN attachment a ON a.ROWID = maj.attachment_id
        WHERE maj.message_id IN (${placeholders})
      `;
      const rows = this.db.prepare(sql).all(...chunk) as Array<Record<string, unknown>>;

      for (const row of rows) {
        const messageId = row.message_id as number;
        const attachments = byMessageId.get(messageId) || [];
        attachments.push({
          filename: (row.filename as string) || undefined,
          mime_type: (row.mime_type as string) || undefined,
          transfer_name: (row.transfer_name as string) || undefined,
        });
        byMessageId.set(messageId, attachments);
      }
    }

    return byMessageId;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function isoToCoreData(iso: string): number {
  const unixMs = new Date(iso).getTime();
  const unixSeconds = unixMs / 1000;
  return (unixSeconds - CORE_DATA_EPOCH_OFFSET) * 1_000_000_000;
}

function extractAttributedBodyText(body?: Buffer | null): string {
  if (!body?.length) return '';

  const nsString = Buffer.from('NSString', 'utf8');
  const marker = Buffer.from([0x95, 0x84, 0x01, 0x2b]);
  let searchFrom = 0;

  while (searchFrom < body.length) {
    const stringClassAt = body.indexOf(nsString, searchFrom);
    if (stringClassAt === -1) return '';

    const markerAt = body.indexOf(marker, stringClassAt + nsString.length);
    if (markerAt === -1) return '';

    const lengthAt = markerAt + marker.length;
    const parsed = readArchivedStringLength(body, lengthAt);
    if (!parsed) {
      searchFrom = stringClassAt + nsString.length;
      continue;
    }

    const { length, offset } = parsed;
    const start = lengthAt + offset;
    const end = start + length;
    if (length <= 0 || end > body.length) {
      searchFrom = stringClassAt + nsString.length;
      continue;
    }

    const text = body.subarray(start, end).toString('utf8').trim();
    if (isLikelyMessageText(text)) return text;

    searchFrom = stringClassAt + nsString.length;
  }

  return '';
}

function readArchivedStringLength(
  body: Buffer,
  offset: number,
): { length: number; offset: number } | null {
  const first = body[offset];
  if (first === undefined) return null;
  if (first < 0x80) return { length: first, offset: 1 };

  const byteCount = first & 0x7f;
  if (byteCount <= 0 || byteCount > 4 || offset + byteCount >= body.length) return null;

  let length = 0;
  for (let i = 1; i <= byteCount; i++) {
    length = (length << 8) + body[offset + i];
  }

  return { length, offset: 1 + byteCount };
}

function isLikelyMessageText(text: string): boolean {
  if (!text) return false;
  if (text.includes('\u0000')) return false;

  const blocked = new Set([
    'NSString',
    'NSMutableString',
    'NSAttributedString',
    'NSMutableAttributedString',
    'NSObject',
    'NSDictionary',
    'NSNumber',
    'NSValue',
    'NSData',
    'NSMutableData',
    'NSKeyedArchiver',
  ]);
  if (blocked.has(text)) return false;
  if (text.startsWith('__kIM')) return false;

  return /[\p{L}\p{N}]/u.test(text);
}
