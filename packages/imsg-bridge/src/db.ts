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

// ── Types (match ImsgClient interface) ──────────────────────────────────────

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

export class ImsgDatabase {
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

    return rows.map((row) => {
      const msgId = row.id as number;
      const attachments = this.getMessageAttachments(msgId);
      const reactions = this.getMessageReactions(msgId);

      return {
        id: msgId,
        chat_id: chatId,
        guid: (row.guid as string) || `imsg-local-${msgId}`,
        sender: (row.handle_id as string) || '',
        is_from_me: (row.is_from_me as number) === 1,
        text: (row.text as string) || '',
        created_at: coreDataToISO(row.date as number | null),
        attachments,
        reactions,
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

  private getMessageAttachments(messageId: number): Attachment[] {
    const sql = `
      SELECT a.filename, a.mime_type, a.transfer_name
      FROM attachment a
      JOIN message_attachment_join maj ON maj.attachment_id = a.ROWID
      WHERE maj.message_id = ?
    `;
    const rows = this.db.prepare(sql).all(messageId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      filename: (r.filename as string) || undefined,
      mime_type: (r.mime_type as string) || undefined,
      transfer_name: (r.transfer_name as string) || undefined,
    }));
  }

  private getMessageReactions(messageId: number): Reaction[] {
    // Reactions in iMessage are stored as associated messages with type 2000-2005
    const sql = `
      SELECT
        h.id as sender,
        m.associated_message_type as type
      FROM message m
      LEFT JOIN handle h ON h.ROWID = m.handle_id
      WHERE m.associated_message_guid LIKE '%' || (
        SELECT guid FROM message WHERE ROWID = ?
      )
      AND m.associated_message_type BETWEEN 2000 AND 2005
    `;
    const rows = this.db.prepare(sql).all(messageId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      sender: (r.sender as string) || undefined,
      type: reactionTypeToString(r.type as number),
    }));
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function isoToCoreData(iso: string): number {
  const unixMs = new Date(iso).getTime();
  const unixSeconds = unixMs / 1000;
  return (unixSeconds - CORE_DATA_EPOCH_OFFSET) * 1_000_000_000;
}

function reactionTypeToString(type: number): string {
  const map: Record<number, string> = {
    2000: 'love',
    2001: 'like',
    2002: 'dislike',
    2003: 'laugh',
    2004: 'emphasis',
    2005: 'question',
  };
  return map[type] || `reaction-${type}`;
}
