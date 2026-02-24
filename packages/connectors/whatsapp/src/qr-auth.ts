import BaileysDefault, { useMultiFileAuthState, DisconnectReason, makeCacheableSignalKeyStore } from '@whiskeysockets/baileys';
// CJS/ESM interop: baileys exports as CommonJS default, which may be nested under .default
const makeWASocket: typeof BaileysDefault = (BaileysDefault as any).default ?? BaileysDefault;
import * as QRCode from 'qrcode';
import type { AuthContext } from '@botmem/connector-sdk';

// Silent logger — suppress Baileys' verbose pino output from the API console
const silentLogger = {
  level: 'silent',
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  child: () => silentLogger,
} as any;

export interface QrAuthCallbacks {
  onQrCode: (qrDataUrl: string) => void;
  onConnected: (auth: AuthContext) => void;
  onError: (error: Error) => void;
}

// Fatal status codes that should not trigger a reconnect
const FATAL_CODES = new Set([
  DisconnectReason.loggedOut,
  DisconnectReason.badSession,
  DisconnectReason.multideviceMismatch,
]);

export async function startQrAuth(
  sessionDir: string,
  callbacks: QrAuthCallbacks,
  maxRetries = 10,
): Promise<void> {
  let retries = 0;
  let settled = false; // true once onQrCode or onConnected has been called

  const attempt = async () => {
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    const sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      logger: silentLogger,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        settled = true;
        const qrDataUrl = await QRCode.toDataURL(qr);
        callbacks.onQrCode(qrDataUrl);
      }

      if (connection === 'open') {
        settled = true;
        callbacks.onConnected({
          raw: { sessionDir, jid: sock.user?.id },
        });
      }

      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;

        // Fatal error — stop retrying
        if (FATAL_CODES.has(statusCode)) {
          callbacks.onError(new Error(`WhatsApp authentication failed (${statusCode})`));
          return;
        }

        // If QR was already shown or we connected, a close is a real failure
        if (settled) {
          callbacks.onError(new Error('WhatsApp connection closed'));
          return;
        }

        // Transient failure before QR appeared — back off and retry quickly
        // Use short backoff (500ms base) so the QR appears fast for waiting users
        if (retries < maxRetries) {
          retries++;
          const delay = Math.min(500 * Math.pow(2, retries - 1), 10_000);
          setTimeout(attempt, delay);
        } else {
          callbacks.onError(new Error('Failed to connect to WhatsApp after retries'));
        }
      }
    });
  };

  await attempt();
}
