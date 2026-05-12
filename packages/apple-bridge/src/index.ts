// Public API for programmatic use
export { ImsgDatabase } from './db.js';
export type { Chat, Message, Attachment, Reaction } from './db.js';
export { RpcHandler } from './rpc-handler.js';
export { TunnelClient } from './tunnel.js';
export type { TunnelOptions, TunnelStatus } from './tunnel.js';
export {
  generateKeyPair,
  exportPublicKey,
  importPublicKey,
  deriveSessionKey,
  encrypt,
  decrypt,
  encryptJson,
  decryptJson,
} from './crypto.js';
