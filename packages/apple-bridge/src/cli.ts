#!/usr/bin/env node

/**
 * Botmem Apple Bridge CLI.
 *
 * Usage:
 *   npx @botmem/apple-bridge --token=<token> [--server=wss://botmem.xyz/imsg-tunnel]
 */

import { Command } from 'commander';
import { runPreflight, DEFAULT_DB_PATH } from './preflight.js';
import { ImsgDatabase } from './db.js';
import { RpcHandler } from './rpc-handler.js';
import { TunnelClient } from './tunnel.js';

const DEFAULT_SERVER = 'wss://botmem.xyz/imsg-tunnel';

const program = new Command();

function timestamp(): string {
  return new Date().toISOString();
}

function log(message = ''): void {
  console.log(message ? `  ${timestamp()} ${message}` : '');
}

function error(message = ''): void {
  console.error(message ? `  ${timestamp()} ${message}` : '');
}

program
  .name('apple-bridge')
  .description('Botmem Apple Bridge — syncs local Apple data securely')
  .requiredOption('--token <token>', 'Bridge token from your Botmem dashboard')
  .option('--server <url>', 'Botmem server URL', DEFAULT_SERVER)
  .option('--db <path>', 'Path to chat.db', DEFAULT_DB_PATH)
  .action(async (opts: { token: string; server: string; db: string }) => {
    console.log('\n  BOTMEM APPLE BRIDGE\n');

    // ── Preflight ─────────────────────────────────────────────────────────
    log('Checking prerequisites...');
    const preflight = runPreflight(opts.db);

    if (!preflight.ok) {
      error('PREFLIGHT FAILED:');
      for (const err of preflight.errors) {
        for (const line of err.split('\n')) {
          error(line);
        }
      }
      process.exit(1);
    }

    log(`iMessage database: ${preflight.dbPath}`);
    log(`Chats found: ${preflight.chatCount ?? 'unknown'}`);

    // ── Open database ─────────────────────────────────────────────────────
    const db = new ImsgDatabase(opts.db);
    const rpcHandler = new RpcHandler(db);

    // ── Connect tunnel ────────────────────────────────────────────────────
    console.log('');
    log(`Connecting to ${opts.server}...`);

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
      log(`[${icon}] ${status}`);
    });

    tunnel.on('log', (msg: string) => {
      log(msg);
    });

    tunnel.on('fatal', (msg: string) => {
      console.error('');
      error(`FATAL: ${msg}`);
      console.error('');
      db.close();
      process.exit(1);
    });

    tunnel.connect();

    // ── Graceful shutdown ─────────────────────────────────────────────────
    const shutdown = () => {
      console.log('');
      log('Shutting down...');
      tunnel.destroy();
      db.close();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });

program.parse();
