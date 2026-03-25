/**
 * JSON-RPC 2.0 request handler.
 * Dispatches incoming requests to the SQLite query layer.
 */

import type { ImsgDatabase } from './db.js';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

export class RpcHandler {
  constructor(private db: ImsgDatabase) {}

  handle(request: JsonRpcRequest): JsonRpcResponse {
    const { id, method, params } = request;

    try {
      switch (method) {
        case 'chats.list': {
          const limit = params?.limit as number | undefined;
          const chats = this.db.chatsList(limit);
          return { jsonrpc: '2.0', id, result: { chats } };
        }

        case 'messages.history': {
          const chatId = params?.chat_id as number;
          if (chatId === undefined || chatId === null) {
            return {
              jsonrpc: '2.0',
              id,
              error: { code: -32602, message: 'Missing required param: chat_id' },
            };
          }
          const opts = {
            limit: params?.limit as number | undefined,
            start: params?.start as string | undefined,
            end: params?.end as string | undefined,
          };
          const messages = this.db.messagesHistory(chatId, opts);
          return { jsonrpc: '2.0', id, result: { messages } };
        }

        case 'ping': {
          return { jsonrpc: '2.0', id, result: { pong: true, ts: Date.now() } };
        }

        default:
          return {
            jsonrpc: '2.0',
            id,
            error: { code: -32601, message: `Method not found: ${method}` },
          };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32000, message: msg },
      };
    }
  }
}
