#!/usr/bin/env node

/**
 * botmem CLI.
 *
 * Usage:
 *   npx @botmem/apple-bridge --token=<token> [--server=wss://api.botmem.xyz/apple-tunnel]
 */

import { Command } from 'commander';
import { runPreflight, DEFAULT_DB_PATH, detectRunnerName } from './preflight.js';
import { AppleMessagesDatabase } from './db.js';
import { RpcHandler } from './rpc-handler.js';
import { TunnelClient } from './tunnel.js';
import { LocalIndex } from './local-index/local-index.js';
import { BridgeStatus, type StatusSource } from './status-writer.js';
import {
  defaultConfigPath,
  formatSources,
  getStatus,
  loadConfig,
  mergeConfig,
  parseSources,
  removeService,
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
  .description('botmem — syncs local Apple data securely')
  .option('--config <path>', 'Path to local botmem config.json')
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

      // Structured status file the macOS app polls. Best-effort; never fatal.
      const status = new BridgeStatus();
      status.setState('starting', 'Bridge starting');
      status.pushActivity('Bridge starting');

      let fileConfig;
      try {
        fileConfig = loadConfig(opts.config || defaultConfigPath());
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        error(msg);
        status.setState('error', 'Config load failed');
        status.setError(msg);
        status.close();
        process.exit(1);
      }
      const merged = mergeConfig(fileConfig, {
        token: opts.token,
        server: opts.server,
        sources: opts.sources !== 'contacts,imessages' ? opts.sources : undefined,
      });
      const token = merged.token;
      const server = merged.server;
      if (server) status.setServer(server);
      const sourceList = merged.sources;
      const sources = parseSources(sourceList);

      if (!token) {
        error('Missing bridge token. Pass --token or --config with a token.');
        status.setState('error', 'Missing bridge token');
        status.setError('Missing bridge token');
        status.close();
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
        status.setState('error', 'Preflight failed');
        status.setError('Preflight failed — check Apple permissions');
        status.close();
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

      // ── Build local search index ──────────────────────────────────────────
      // Bridge-owned FTS index over Contacts + iMessage + (if present) WhatsApp.
      // Logs are privacy-safe (counts/durations/source names only).
      // Tracks whether the tunnel is currently connected, so an index build that
      // finishes after connect (or vice versa) can promote the state to 'live'.
      let tunnelConnected = false;
      const goLiveIfReady = () => {
        if (tunnelConnected && !localIndex.isBuilding) {
          const sources: StatusSource[] = localIndex
            .status()
            .map((s) => ({ source: s.source, count: s.count }));
          status.setSources(sources);
          status.setState('live', 'Live · serving search');
        }
      };

      const localIndex = new LocalIndex({
        log: (msg) => log(msg),
        onProgress: ({ source, count }) => {
          status.setIndexing({ active: true, source, done: count, total: null });
          status.pushActivity(`Indexed ${count} ${source} records`);
        },
      });
      log('Building local search index...');
      status.setState('indexing', 'Indexing local sources…');
      status.setIndexing({ active: true, source: null, done: 0, total: null });
      status.pushActivity('Indexing started');
      localIndex
        .refresh()
        .then(() => {
          log('Local search index ready');
          status.setIndexing({ active: false, source: null, done: 0, total: null });
          status.pushActivity('Indexing complete');
          goLiveIfReady();
        })
        .catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          error(`Index build failed: ${msg}`);
          status.setIndexing({ active: false, source: null, done: 0, total: null });
          status.setError(`Index build failed: ${msg}`);
          status.pushActivity('Indexing failed');
        });

      // Periodic refresh keeps the index reasonably fresh while the bridge runs.
      const INDEX_REFRESH_MS = 6 * 60 * 60 * 1000; // every 6 hours
      const refreshTimer = setInterval(() => {
        localIndex
          .refresh()
          .catch((err) =>
            error(`Index refresh failed: ${err instanceof Error ? err.message : err}`),
          );
      }, INDEX_REFRESH_MS);
      refreshTimer.unref?.();

      const rpcHandler = new RpcHandler(getDb, localIndex);

      // ── Connect tunnel ────────────────────────────────────────────────────
      console.log('');
      log(`Connecting to ${server}...`);
      const serverHost = (() => {
        try {
          return new URL(server).host;
        } catch {
          return server;
        }
      })();
      status.setState('connecting', `Connecting to ${serverHost}…`);
      status.pushActivity(`Connecting to ${serverHost}`);

      // Advertise the new local-search capability alongside the existing sources
      // string without breaking the legacy contacts/imessages list.
      const advertisedSources = sourceList ? `${sourceList},search` : 'search';

      const tunnel = new TunnelClient({
        serverUrl: server,
        token,
        rpcHandler,
        sources: advertisedSources,
        status,
      });

      tunnel.on('status', (tunnelStatus: string) => {
        const icon =
          {
            connecting: '...',
            authenticating: '...',
            connected: 'OK',
            disconnected: '--',
            error: '!!',
          }[tunnelStatus] || '??';
        log(`[${icon}] ${tunnelStatus}`);
        if (tunnelStatus === 'connected') {
          tunnelConnected = true;
          goLiveIfReady();
        } else if (tunnelStatus === 'disconnected' || tunnelStatus === 'error') {
          tunnelConnected = false;
        }
      });

      tunnel.on('log', (msg: string) => {
        log(msg);
      });

      tunnel.on('fatal', (msg: string) => {
        console.error('');
        error(`FATAL: ${msg}`);
        console.error('');
        status.setState('error', 'Fatal error');
        status.setError(msg);
        status.pushActivity('Fatal error — bridge stopped');
        status.close();
        clearInterval(refreshTimer);
        localIndex.close();
        db?.close();
        process.exit(1);
      });

      tunnel.connect();

      // ── Graceful shutdown ─────────────────────────────────────────────────
      const shutdown = () => {
        console.log('');
        log('Shutting down...');
        status.setConnected(false);
        status.setState('offline', 'Bridge stopped');
        status.pushActivity('Bridge stopped');
        status.close();
        tunnel.destroy();
        clearInterval(refreshTimer);
        localIndex.close();
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

// Background supervision is owned by the signed macOS app, which spawns this
// CLI as its own child so Full Disk Access is inherited (a launchd-spawned node
// would lose FDA). The CLI therefore does NOT install a LaunchAgent. For
// headless/server use, run the default `apple-bridge` action in the foreground
// (e.g. under your own process manager). `service stop` only tears down any
// legacy node LaunchAgent left by older CLI versions.
const service = program.command('service').description('Manage legacy bridge LaunchAgents');

service
  .command('stop')
  .description('Remove any legacy background LaunchAgent installed by older CLI versions')
  .action(() => {
    removeService();
    log('Legacy LaunchAgent removed (if present)');
  });

program.parse();
