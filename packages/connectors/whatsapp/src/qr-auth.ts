import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import * as QRCode from 'qrcode';
import pino from 'pino';
import type { AuthContext } from '@botmem/connector-sdk';

const logger = pino({ level: 'warn' }) as any;

// Cache the fetched version for 1 hour to avoid hitting the API on every warm-up
let cachedVersion: { version: [number, number, number]; fetchedAt: number } | null = null;
const VERSION_TTL = 60 * 60 * 1000;

async function getWhatsAppVersion(): Promise<[number, number, number]> {
  if (cachedVersion && Date.now() - cachedVersion.fetchedAt < VERSION_TTL) {
    return cachedVersion.version;
  }
  try {
    const { version } = await fetchLatestBaileysVersion();
    cachedVersion = { version: version as [number, number, number], fetchedAt: Date.now() };
    return cachedVersion.version;
  } catch {
    // Fallback to cached or default
    return cachedVersion?.version ?? [2, 3000, 1033846690];
  }
}

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

// Codes that mean "reconnect needed" — expected after QR scan
const RECONNECT_CODES = new Set([
  DisconnectReason.restartRequired,    // 515 — expected after QR scan
  DisconnectReason.connectionClosed,   // 428
  DisconnectReason.connectionReplaced, // 440
  DisconnectReason.timedOut,           // 408
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
    const version = await getWhatsAppVersion();

    const sock = makeWASocket({
      auth: state,
      version,
      printQRInTerminal: false,
      logger,
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

        // Reconnectable codes — retry even after QR was shown (e.g. 515 after scan)
        if (RECONNECT_CODES.has(statusCode) && retries < maxRetries) {
          retries++;
          const delay = Math.min(500 * Math.pow(2, retries - 1), 10_000);
          setTimeout(attempt, delay);
          return;
        }

        // If QR was already shown and it's not a reconnectable code, it's a real failure
        if (settled) {
          callbacks.onError(new Error('WhatsApp connection closed'));
          return;
        }

        // Transient failure before QR appeared — back off and retry quickly
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
