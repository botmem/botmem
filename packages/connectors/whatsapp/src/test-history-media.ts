/**
 * Test script: Can we download media from WhatsApp history messages?
 *
 * Connects via QR, captures history batches, and attempts to download
 * media (images, documents) from history messages to see if the CDN
 * still serves them.
 *
 * Usage:
 *   npx tsx packages/connectors/whatsapp/src/test-history-media.ts
 */

import {
  makeWASocket,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
  downloadContentFromMessage,
} from '@whiskeysockets/baileys';
import type { Transform } from 'stream';
import pino from 'pino';
import { mkdirSync } from 'fs';
import { execSync } from 'child_process';
import * as qrcode from 'qrcode';

const SESSION_DIR = `./data/whatsapp/wa-media-test-${Date.now()}`;
const IDLE_TIMEOUT_MS = 20_000; // 20s idle = done collecting history
const MAX_MEDIA_TESTS = 20; // test up to 20 media messages
const DOWNLOAD_TIMEOUT_MS = 15_000; // 15s per download attempt

const logger = pino({ level: 'silent' }) as any;

interface MediaTestResult {
  messageId: string;
  chatJid: string;
  type: string;
  mimetype: string;
  fileName?: string;
  hasMediaKey: boolean;
  hasDirectPath: boolean;
  hasUrl: boolean;
  timestamp: Date;
  ageHours: number;
  downloadSuccess: boolean;
  downloadBytes: number;
  downloadMs: number;
  error?: string;
}

async function main() {
  mkdirSync(SESSION_DIR, { recursive: true });
  console.log(`Session dir: ${SESSION_DIR}`);
  console.log('Connecting to WhatsApp...\n');

  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    version,
    browser: ['Mac OS', 'Chrome', '10.15.7'],
    printQRInTerminal: false,
    logger,
    syncFullHistory: true,
    markOnlineOnConnect: false,
    getMessage: async () => undefined,
  });

  sock.ev.on('creds.update', saveCreds);

  // Phase 1: Connect (QR or existing creds)
  let connected = false;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Connection timeout (60s)')), 60_000);

    sock.ev.on('connection.update', async (update: any) => {
      if (update.qr) {
        const qrPath = '/tmp/wa-media-test-qr.png';
        await qrcode.toFile(qrPath, update.qr, { scale: 8 });
        console.log(`QR code saved to ${qrPath} — opening...`);
        try { execSync(`open ${qrPath}`); } catch { /* ignore */ }
        console.log('Waiting for scan...\n');
      }
      if (update.connection === 'open') {
        connected = true;
        clearTimeout(timeout);
        console.log(`Connected as: ${(sock as any).user?.id || 'unknown'}\n`);
        resolve();
      }
      if (update.connection === 'close' && !connected) {
        clearTimeout(timeout);
        const code = (update.lastDisconnect?.error as any)?.output?.statusCode;
        if (code === 515) {
          console.log('Got 515 restart (normal after QR link) — reconnecting...');
          resolve(); // Let the script continue; we'll handle reconnect outside
        } else {
          reject(new Error(`Connection closed: code=${code}`));
        }
      }
    });
  });

  if (!connected) {
    console.log('Reconnecting after 515...');
    // Need to create a fresh socket for reconnect
    const { state: state2, saveCreds: saveCreds2 } = await useMultiFileAuthState(SESSION_DIR);
    const sock2 = makeWASocket({
      auth: {
        creds: state2.creds,
        keys: makeCacheableSignalKeyStore(state2.keys, logger),
      },
      version,
      browser: ['Mac OS', 'Chrome', '10.15.7'],
      printQRInTerminal: false,
      logger,
      syncFullHistory: true,
      markOnlineOnConnect: false,
      getMessage: async () => undefined,
    });
    sock2.ev.on('creds.update', saveCreds2);

    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Reconnect timeout')), 30_000);
      sock2.ev.on('connection.update', (u: any) => {
        if (u.connection === 'open') { clearTimeout(t); resolve(); }
        if (u.connection === 'close') { clearTimeout(t); reject(new Error('Reconnect failed')); }
      });
    });
    console.log('Reconnected.\n');
    return runMediaTest(sock2);
  }

  return runMediaTest(sock);
}

async function runMediaTest(sock: ReturnType<typeof makeWASocket>) {
  // Phase 2: Collect history messages with media
  const mediaMessages: Array<{
    msg: any;
    type: string;
    mimetype: string;
    fileName?: string;
    chatJid: string;
  }> = [];

  let historyBatches = 0;
  let totalMsgs = 0;

  console.log('Waiting for history messages...\n');

  await new Promise<void>((resolve) => {
    let idleTimer: ReturnType<typeof setTimeout>;
    let finished = false;

    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(idleTimer);
      resolve();
    };

    const resetIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        console.log(`\nIdle timeout (${IDLE_TIMEOUT_MS / 1000}s) — done collecting.\n`);
        finish();
      }, IDLE_TIMEOUT_MS);
    };

    sock.ev.on('messaging-history.set', (data: any) => {
      historyBatches++;
      const messages = data.messages || [];
      totalMsgs += messages.length;

      let batchMedia = 0;
      for (const msg of messages) {
        const m = msg.message;
        if (!m) continue;

        let type = '';
        let mimetype = '';
        let fileName = '';

        if (m.imageMessage) {
          type = 'image';
          mimetype = m.imageMessage.mimetype || 'image/jpeg';
        } else if (m.videoMessage) {
          type = 'video';
          mimetype = m.videoMessage.mimetype || 'video/mp4';
        } else if (m.audioMessage) {
          type = 'audio';
          mimetype = m.audioMessage.mimetype || 'audio/ogg';
        } else if (m.documentMessage) {
          type = 'document';
          mimetype = m.documentMessage.mimetype || 'application/octet-stream';
          fileName = m.documentMessage.fileName || '';
        } else if (m.documentWithCaptionMessage?.message?.documentMessage) {
          const doc = m.documentWithCaptionMessage.message.documentMessage;
          type = 'document';
          mimetype = doc.mimetype || 'application/octet-stream';
          fileName = doc.fileName || '';
        } else if (m.stickerMessage) {
          type = 'sticker';
          mimetype = m.stickerMessage.mimetype || 'image/webp';
        }

        if (type && mediaMessages.length < MAX_MEDIA_TESTS) {
          mediaMessages.push({
            msg,
            type,
            mimetype,
            fileName: fileName || undefined,
            chatJid: msg.key?.remoteJid || 'unknown',
          });
          batchMedia++;
        }
      }

      console.log(
        `  History batch #${historyBatches}: ${messages.length} msgs, ${batchMedia} media (total collected: ${mediaMessages.length}/${MAX_MEDIA_TESTS})`,
      );
      resetIdle();
    });

    // Also capture real-time messages for comparison
    sock.ev.on('messages.upsert', (upsert: any) => {
      const msgs = upsert.messages || [];
      totalMsgs += msgs.length;
      console.log(`  Real-time: ${msgs.length} msgs (type=${upsert.type})`);
      resetIdle();
    });

    resetIdle();
  });

  console.log(`\nCollected ${totalMsgs} total messages, ${mediaMessages.length} with media.\n`);

  if (mediaMessages.length === 0) {
    console.log('No media messages found in history. Cannot test downloads.');
    sock.ws?.close();
    return;
  }

  // Phase 3: Attempt to download each media message
  console.log('=== TESTING MEDIA DOWNLOADS ===\n');
  const results: MediaTestResult[] = [];

  for (let i = 0; i < mediaMessages.length; i++) {
    const { msg, type, mimetype, fileName, chatJid } = mediaMessages[i];
    const m = msg.message;
    const msgTs = Number(msg.messageTimestamp || 0);
    const ageHours = msgTs > 0 ? (Date.now() - msgTs * 1000) / 3600000 : -1;

    // Get the media message object
    let mediaMsg: any = null;
    if (m.imageMessage) mediaMsg = m.imageMessage;
    else if (m.videoMessage) mediaMsg = m.videoMessage;
    else if (m.audioMessage) mediaMsg = m.audioMessage;
    else if (m.documentMessage) mediaMsg = m.documentMessage;
    else if (m.documentWithCaptionMessage?.message?.documentMessage)
      mediaMsg = m.documentWithCaptionMessage.message.documentMessage;
    else if (m.stickerMessage) mediaMsg = m.stickerMessage;

    const result: MediaTestResult = {
      messageId: msg.key?.id || `unknown-${i}`,
      chatJid,
      type,
      mimetype,
      fileName,
      hasMediaKey: !!mediaMsg?.mediaKey,
      hasDirectPath: !!mediaMsg?.directPath,
      hasUrl: !!mediaMsg?.url,
      timestamp: new Date(msgTs * 1000),
      ageHours: Math.round(ageHours * 10) / 10,
      downloadSuccess: false,
      downloadBytes: 0,
      downloadMs: 0,
    };

    if (!mediaMsg?.mediaKey || !mediaMsg?.directPath) {
      result.error = 'Missing mediaKey or directPath';
      results.push(result);
      console.log(
        `  [${i + 1}/${mediaMessages.length}] ${type} (${result.ageHours}h old) — SKIP: ${result.error}`,
      );
      continue;
    }

    const t0 = Date.now();
    try {
      const stream: Transform = await Promise.race([
        downloadContentFromMessage(mediaMsg, type as any),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Download timeout')), DOWNLOAD_TIMEOUT_MS),
        ),
      ]);

      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const buffer = Buffer.concat(chunks);

      result.downloadSuccess = buffer.length > 0;
      result.downloadBytes = buffer.length;
      result.downloadMs = Date.now() - t0;

      const sizeStr =
        buffer.length > 1024 * 1024
          ? `${(buffer.length / 1024 / 1024).toFixed(1)}MB`
          : `${(buffer.length / 1024).toFixed(1)}KB`;

      console.log(
        `  [${i + 1}/${mediaMessages.length}] ${type} (${result.ageHours}h old) — OK: ${sizeStr} in ${result.downloadMs}ms${fileName ? ` [${fileName}]` : ''}`,
      );
    } catch (err: any) {
      result.downloadMs = Date.now() - t0;
      result.error = err.message || String(err);

      console.log(
        `  [${i + 1}/${mediaMessages.length}] ${type} (${result.ageHours}h old) — FAIL: ${result.error}${fileName ? ` [${fileName}]` : ''}`,
      );
    }

    results.push(result);

    // Small delay between downloads
    await new Promise((r) => setTimeout(r, 300));
  }

  // Phase 4: Summary
  console.log('\n=== RESULTS SUMMARY ===\n');

  const succeeded = results.filter((r) => r.downloadSuccess);
  const failed = results.filter((r) => !r.downloadSuccess);
  const missingKeys = results.filter((r) => !r.hasMediaKey || !r.hasDirectPath);

  console.log(`Total tested:     ${results.length}`);
  console.log(`Succeeded:        ${succeeded.length}`);
  console.log(`Failed:           ${failed.length}`);
  console.log(`Missing keys:     ${missingKeys.length}`);
  console.log();

  // Group by type
  const byType = new Map<string, { total: number; ok: number }>();
  for (const r of results) {
    const entry = byType.get(r.type) || { total: 0, ok: 0 };
    entry.total++;
    if (r.downloadSuccess) entry.ok++;
    byType.set(r.type, entry);
  }
  console.log('By type:');
  for (const [type, { total, ok }] of byType) {
    console.log(`  ${type}: ${ok}/${total} succeeded`);
  }

  // Age analysis
  if (succeeded.length > 0) {
    const ages = succeeded.map((r) => r.ageHours).filter((a) => a >= 0);
    console.log(`\nOldest successful download: ${Math.max(...ages).toFixed(1)} hours old`);
    console.log(`Newest successful download: ${Math.min(...ages).toFixed(1)} hours old`);
    const avgSize = succeeded.reduce((s, r) => s + r.downloadBytes, 0) / succeeded.length;
    console.log(`Average file size: ${(avgSize / 1024).toFixed(1)}KB`);
  }

  if (failed.length > 0) {
    console.log('\nFailure reasons:');
    const reasons = new Map<string, number>();
    for (const r of failed) {
      const reason = r.error || 'unknown';
      reasons.set(reason, (reasons.get(reason) || 0) + 1);
    }
    for (const [reason, count] of reasons) {
      console.log(`  ${count}x: ${reason}`);
    }
  }

  console.log('\n=== RAW RESULTS (JSON) ===\n');
  console.log(JSON.stringify(results, null, 2));

  sock.ws?.close();
  console.log('\nDone. Socket closed.');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
