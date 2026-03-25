#!/usr/bin/env node

/**
 * Botmem iMessage Bridge CLI.
 *
 * Usage:
 *   npx @botmem/imsg-bridge --token=<token> [--server=wss://botmem.xyz/imsg-tunnel]
 */

import { Command } from 'commander';
import { runPreflight, DEFAULT_DB_PATH } from './preflight.js';
import { ImsgDatabase } from './db.js';
import { RpcHandler } from './rpc-handler.js';
import { TunnelClient } from './tunnel.js';

const DEFAULT_SERVER = 'wss://botmem.xyz/imsg-tunnel';

const program = new Command();

program
  .name('imsg-bridge')
  .description('Botmem iMessage Bridge — syncs your iMessages securely')
  .requiredOption('--token <token>', 'Bridge token from your Botmem dashboard')
  .option('--server <url>', 'Botmem server URL', DEFAULT_SERVER)
  .option('--db <path>', 'Path to chat.db', DEFAULT_DB_PATH)
  .action(async (opts: { token: string; server: string; db: string }) => {
    console.log('\n  BOTMEM iMESSAGE BRIDGE\n');

    // ── Preflight ─────────────────────────────────────────────────────────
    console.log('  Checking prerequisites...');
    const preflight = runPreflight(opts.db);

    if (!preflight.ok) {
      console.error('\n  PREFLIGHT FAILED:\n');
      for (const err of preflight.errors) {
        console.error(`  ${err.split('\n').join('\n  ')}\n`);
      }
      process.exit(1);
    }

    console.log(`  iMessage database: ${preflight.dbPath}`);
    console.log(`  Chats found: ${preflight.chatCount ?? 'unknown'}`);

    // ── Open database ─────────────────────────────────────────────────────
    const db = new ImsgDatabase(opts.db);
    const rpcHandler = new RpcHandler(db);

    // ── Connect tunnel ────────────────────────────────────────────────────
    console.log(`\n  Connecting to ${opts.server}...`);

    const tunnel = new TunnelClient({
      serverUrl: opts.server,
      token: opts.token,
      rpcHandler,
    });

    tunnel.on('status', (status: string) => {
      const icon =
        {
          connecting: '...',
          authenticating: '...',
          connected: 'OK',
          disconnected: '--',
          error: '!!',
        }[status] || '??';
      console.log(`  [${icon}] ${status}`);
    });

    tunnel.on('log', (msg: string) => {
      console.log(`  ${msg}`);
    });

    tunnel.connect();

    // ── Graceful shutdown ─────────────────────────────────────────────────
    const shutdown = () => {
      console.log('\n  Shutting down...');
      tunnel.destroy();
      db.close();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });

program.parse();
