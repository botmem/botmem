/**
 * JSON-RPC client for the iMessage bridge.
 *
 * Transport-agnostic: works with either TcpTransport (local socat bridge)
 * or WsTunnelTransport (remote bridge via encrypted WebSocket tunnel).
 */

import type { RpcTransport } from './transport';

// ── Types ────────────────────────────────────────────────────────────────────

export interface Attachment {
  filename?: string;
  mime_type?: string;
  transfer_name?: string;
}

export interface Reaction {
  sender?: string;
  type?: string;
}

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

// ── Client ───────────────────────────────────────────────────────────────────

export class ImsgClient {
  private transport: RpcTransport;

  constructor(transport: RpcTransport) {
    this.transport = transport;
  }

  /** Open connection to the iMessage RPC bridge. */
  async connect(): Promise<void> {
    await this.transport.connect();
  }

  /** Close the connection. */
  disconnect(): void {
    this.transport.disconnect();
  }

  /** List chats from the iMessage database. */
  async chatsList(limit?: number): Promise<Chat[]> {
    const params: Record<string, unknown> = {};
    if (limit !== undefined) params.limit = limit;
    const result = (await this.transport.call('chats.list', params)) as { chats: Chat[] };
    return result.chats;
  }

  /** Retrieve message history for a chat. */
  async messagesHistory(
    chatId: number,
    opts?: { limit?: number; start?: string; end?: string; attachments?: boolean },
  ): Promise<Message[]> {
    const params: Record<string, unknown> = { chat_id: chatId };
    if (opts?.limit !== undefined) params.limit = opts.limit;
    if (opts?.start !== undefined) params.start = opts.start;
    if (opts?.end !== undefined) params.end = opts.end;
    if (opts?.attachments !== undefined) params.attachments = opts.attachments;
    const result = (await this.transport.call('messages.history', params)) as {
      messages: Message[];
    };
    return result.messages;
  }
}
