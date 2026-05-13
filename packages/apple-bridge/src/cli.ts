#!/usr/bin/env node

/**
 * Botmem Apple Bridge CLI.
 *
 * Usage:
 *   npx @botmem/apple-bridge --token=<token> [--server=wss://botmem.xyz/apple-tunnel]
 */

import { Command } from 'commander';
import { runPreflight, DEFAULT_DB_PATH, detectRunnerName } from './preflight.js';
import { AppleMessagesDatabase } from './db.js';
import { RpcHandler } from './rpc-handler.js';
import { TunnelClient } from './tunnel.js';
import {
  defaultConfigPath,
  formatSources,
  getStatus,
  installService,
  loadConfig,
  mergeConfig,
  parseSources,
  removeService,
  restartService,
  saveConfig,
  tunnelUrlFromHost,
} from './setup.js';

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
  .option('--config <path>', 'Path to local Botmem Apple Bridge config.json')
  .option('--token <token>', 'Bridge token from your Botmem dashboard')
  .option('--server <url>', 'Botmem tunnel WebSocket URL')
  .option('--db <path>', 'Path to chat.db', DEFAULT_DB_PATH)
  .option('--sources <list>', 'Comma-separated sources: contacts,imessages', 'contacts,imessages')
  .action(
    async (opts: {
      config?: string;
      token?: string;
      server?: string;
      db: string;
      sources: string;
    }) => {
      console.log('\n  BOTMEM APPLE BRIDGE\n');
      let fileConfig;
      try {
        fileConfig = loadConfig(opts.config || defaultConfigPath());
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
      const merged = mergeConfig(fileConfig, {
        token: opts.token,
        server: opts.server,
        sources: opts.sources !== 'contacts,imessages' ? opts.sources : undefined,
      });
      const token = merged.token;
      const server = merged.server;
      const sourceList = merged.sources;
      const sources = parseSources(sourceList);

      if (!token) {
        error('Missing bridge token. Pass --token or --config with a token.');
        process.exit(1);
      }

      // ── Preflight ─────────────────────────────────────────────────────────
      log('Checking prerequisites...');
      const preflight = runPreflight(opts.db, {
        requireMessages: sources.imessages,
        runnerName: detectRunnerName(),
      });

      if (!preflight.ok) {
        error('PREFLIGHT FAILED:');
        for (const err of preflight.errors) {
          for (const line of err.split('\n')) {
            error(line);
          }
        }
        process.exit(1);
      }

      log(
        `Sources: ${sources.contacts ? 'contacts' : ''}${sources.contacts && sources.imessages ? ', ' : ''}${sources.imessages ? 'imessages' : ''}`,
      );
      if (sources.imessages) {
        log(`iMessage database: ${preflight.dbPath}`);
        log(`Chats found: ${preflight.chatCount ?? 'unknown'}`);
      } else {
        log('iMessage database check skipped for contacts-only mode');
      }

      // ── Open database ─────────────────────────────────────────────────────
      let db: AppleMessagesDatabase | null = null;
      const getDb = () => {
        db ??= new AppleMessagesDatabase(opts.db);
        return db;
      };
      const rpcHandler = new RpcHandler(getDb);

      // ── Connect tunnel ────────────────────────────────────────────────────
      console.log('');
      log(`Connecting to ${server}...`);

      const tunnel = new TunnelClient({
        serverUrl: server,
        token,
        rpcHandler,
        sources: sourceList,
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
        db?.close();
        process.exit(1);
      });

      tunnel.connect();

      // ── Graceful shutdown ─────────────────────────────────────────────────
      const shutdown = () => {
        console.log('');
        log('Shutting down...');
        tunnel.destroy();
        db?.close();
        process.exit(0);
      };

      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    },
  );

program
  .command('configure')
  .description('Write local bridge config used by both the CLI and macOS app')
  .requiredOption('--token <token>', 'Bridge token from Botmem')
  .option('--server <url>', 'Botmem tunnel WebSocket URL')
  .option('--host <url>', 'Botmem HTTP(S) host, converted to the tunnel URL')
  .option('--account-id <id>', 'Botmem Apple account ID')
  .option('--sources <list>', 'Comma-separated sources: contacts,imessages', 'contacts,imessages')
  .option('--config <path>', 'Config path', defaultConfigPath())
  .action(
    (opts: {
      token: string;
      server?: string;
      host?: string;
      accountId?: string;
      sources: string;
      config: string;
    }) => {
      const server = opts.server || tunnelUrlFromHost(opts.host);
      const sources = formatSources(parseSources(opts.sources));
      saveConfig(
        {
          server,
          token: opts.token,
          accountId: opts.accountId || '',
          sources,
        },
        opts.config,
      );
      log(`Config saved: ${opts.config}`);
      log(`Server: ${server}`);
      log(`Sources: ${sources || 'none'}`);
    },
  );

program
  .command('preflight')
  .description('Check local Apple permissions for the configured sources')
  .option('--config <path>', 'Config path', defaultConfigPath())
  .option('--db <path>', 'Path to chat.db', DEFAULT_DB_PATH)
  .option('--sources <list>', 'Override sources for this check')
  .action((opts: { config: string; db: string; sources?: string }) => {
    const config = loadConfig(opts.config);
    const sources = parseSources(opts.sources || config.sources);
    const result = runPreflight(opts.db, {
      requireMessages: sources.imessages,
      runnerName: detectRunnerName(),
    });
    if (result.ok) {
      log('Preflight OK');
      if (sources.imessages) {
        log(`iMessage database: ${result.dbPath}`);
        log(`Chats found: ${result.chatCount ?? 'unknown'}`);
      } else {
        log('iMessage database check skipped for contacts-only mode');
      }
      return;
    }
    error('Preflight failed:');
    for (const failure of result.errors) {
      for (const line of failure.split('\n')) error(line);
    }
    process.exit(1);
  });

program
  .command('status')
  .description('Show shared bridge config, permission, and service state')
  .option('--config <path>', 'Config path', defaultConfigPath())
  .option('--json', 'Print machine-readable JSON')
  .action((opts: { config: string; json?: boolean }) => {
    const status = getStatus(opts.config);
    if (opts.json) {
      console.log(JSON.stringify(status, null, 2));
      return;
    }
    log(`Configured: ${status.configured ? 'yes' : 'no'}`);
    log(`Config: ${status.configPath}`);
    log(`Server: ${status.server || 'not set'}`);
    log(`Account: ${status.accountId || 'not set'}`);
    log(`Sources: ${formatSources(status.sources) || 'none'}`);
    log(
      `Messages access: ${
        status.permissions.messages === null
          ? 'not required'
          : status.permissions.messages
            ? 'ok'
            : 'missing'
      }`,
    );
    log(`Service installed: ${status.service.installed ? 'yes' : 'no'}`);
    log(`Service running: ${status.service.loaded ? 'yes' : 'no'}`);
  });

const service = program.command('service').description('Manage the background bridge LaunchAgent');

service
  .command('start')
  .description('Install and start the background sync service')
  .option('--config <path>', 'Config path', defaultConfigPath())
  .option('--runner <path>', 'Runner path for the LaunchAgent')
  .action((opts: { config: string; runner?: string }) => {
    installService({ configPath: opts.config, runnerPath: opts.runner });
    restartService();
    log('Service started');
  });

service
  .command('restart')
  .description('Restart the background sync service')
  .action(() => {
    restartService();
    log('Service restarted');
  });

service
  .command('stop')
  .description('Unload and remove the background sync service')
  .action(() => {
    removeService();
    log('Service removed');
  });

program.parse();
