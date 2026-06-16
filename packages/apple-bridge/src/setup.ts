import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DEFAULT_DB_PATH, detectRunnerName, runPreflight } from './preflight.js';

export const DEFAULT_BOTMEM_HOST = 'https://api.botmem.xyz';
export const DEFAULT_TUNNEL_PATH = '/apple-tunnel';
export const LAUNCH_AGENT_LABEL = 'xyz.botmem.apple-bridge.service';

export interface BridgeSources {
  contacts: boolean;
  imessages: boolean;
}

export interface BridgeConfigFile {
  server?: string;
  token?: string;
  accountId?: string;
  sources?: string;
}

export interface BridgeStatus {
  configured: boolean;
  configPath: string;
  server: string | null;
  accountId: string | null;
  sources: BridgeSources;
  permissions: {
    messages: boolean | null;
  };
  service: {
    installed: boolean;
    loaded: boolean;
    plistPath: string;
  };
}

/**
 * Canonical botmem data dir: ~/.botmem. This is the SINGLE shared location for
 * config.json, service.log, and bridge-status.json — used by both the CLI and
 * the macOS app, so they never disagree about where state lives.
 */
export function botmemDir(): string {
  return join(homedir(), '.botmem');
}

export function defaultConfigPath(): string {
  return join(botmemDir(), 'config.json');
}

export function launchAgentPath(): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${LAUNCH_AGENT_LABEL}.plist`);
}

export function serviceLogPath(): string {
  return join(botmemDir(), 'service.log');
}

export function normalizeBotmemHost(raw: string | undefined): string {
  const value = (raw || DEFAULT_BOTMEM_HOST).trim();
  if (!value) return DEFAULT_BOTMEM_HOST;
  return value.includes('://') ? value.replace(/\/+$/, '') : `https://${value.replace(/\/+$/, '')}`;
}

export function tunnelUrlFromHost(raw: string | undefined): string {
  const host = normalizeBotmemHost(raw);
  const url = new URL(host);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = DEFAULT_TUNNEL_PATH;
  url.search = '';
  url.hash = '';
  return url.toString();
}

export function parseSources(value: string | undefined): BridgeSources {
  const parts = (value || 'contacts,imessages')
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  return {
    contacts: parts.length === 0 || parts.includes('contacts'),
    imessages: parts.length === 0 || parts.includes('imessages') || parts.includes('messages'),
  };
}

export function formatSources(sources: BridgeSources): string {
  return [sources.contacts ? 'contacts' : null, sources.imessages ? 'imessages' : null]
    .filter(Boolean)
    .join(',');
}

export function loadConfig(path = defaultConfigPath()): BridgeConfigFile {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf8')) as BridgeConfigFile;
}

export function saveConfig(config: BridgeConfigFile, path = defaultConfigPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

export function mergeConfig(
  fileConfig: BridgeConfigFile,
  overrides: BridgeConfigFile,
): Required<BridgeConfigFile> {
  const server =
    overrides.server ||
    fileConfig.server ||
    tunnelUrlFromHost(process.env.BOTMEM_HOST || DEFAULT_BOTMEM_HOST);
  return {
    server,
    token: overrides.token || fileConfig.token || '',
    accountId: overrides.accountId || fileConfig.accountId || '',
    sources: overrides.sources || fileConfig.sources || 'contacts,imessages',
  };
}

function guiDomain(): string {
  return `gui/${process.getuid?.() ?? 0}`;
}

function serviceTarget(): string {
  return `${guiDomain()}/${LAUNCH_AGENT_LABEL}`;
}

function launchctl(args: string[]): number {
  return spawnSync('/bin/launchctl', args, { stdio: 'ignore' }).status ?? 1;
}

export function isServiceLoaded(): boolean {
  return launchctl(['print', serviceTarget()]) === 0;
}

/**
 * Remove the bridge LaunchAgent (e.g. the macOS app's app-supervisor agent, or
 * a stale node-runner agent from an older CLI). The CLI no longer INSTALLS a
 * LaunchAgent: a launchd-spawned node loses Full Disk Access because launchd —
 * not the signed app — becomes the responsible process for TCC. Background
 * supervision is owned exclusively by the signed macOS app, which spawns node
 * as its own child so FDA is inherited. The CLI runs the bridge in the
 * foreground (the default `apple-bridge` action) for headless/server use.
 */
export function removeService(): void {
  launchctl(['bootout', guiDomain(), launchAgentPath()]);
  rmSync(launchAgentPath(), { force: true });
}

export function getStatus(configPath = defaultConfigPath()): BridgeStatus {
  const config = loadConfig(configPath);
  const sources = parseSources(config.sources);
  const requireMessages = sources.imessages;
  const preflight = runPreflight(DEFAULT_DB_PATH, {
    requireMessages,
    runnerName: detectRunnerName(),
  });

  return {
    configured: Boolean(config.token && config.server),
    configPath,
    server: config.server || null,
    accountId: config.accountId || null,
    sources,
    permissions: {
      messages: requireMessages ? preflight.ok : null,
    },
    service: {
      installed: existsSync(launchAgentPath()),
      loaded: isServiceLoaded(),
      plistPath: launchAgentPath(),
    },
  };
}
