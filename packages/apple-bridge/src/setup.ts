import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DEFAULT_DB_PATH, detectRunnerName, runPreflight } from './preflight.js';

export const DEFAULT_BOTMEM_HOST = 'https://botmem.xyz';
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

export function appSupportDir(): string {
  return join(homedir(), 'Library', 'Application Support', 'botmem');
}

export function defaultConfigPath(): string {
  return join(appSupportDir(), 'config.json');
}

export function launchAgentPath(): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${LAUNCH_AGENT_LABEL}.plist`);
}

export function serviceLogPath(): string {
  return join(appSupportDir(), 'service.log');
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

export function installService(options: { configPath?: string; runnerPath?: string } = {}): void {
  const configPath = options.configPath || defaultConfigPath();
  const runnerPath = options.runnerPath || resolveRunnerPath();
  const plistPath = launchAgentPath();

  mkdirSync(appSupportDir(), { recursive: true });
  mkdirSync(dirname(plistPath), { recursive: true });

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(runnerPath)}</string>
    <string>--config</string>
    <string>${escapeXml(configPath)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>BOTMEM_BRIDGE_RUNNER_NAME</key>
    <string>botmem</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${escapeXml(serviceLogPath())}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(serviceLogPath())}</string>
  <key>WorkingDirectory</key>
  <string>${escapeXml(dirname(runnerPath))}</string>
</dict>
</plist>
`;
  writeFileSync(plistPath, plist, { mode: 0o644 });
}

export function restartService(): void {
  launchctl(['bootout', guiDomain(), launchAgentPath()]);
  launchctl(['bootstrap', guiDomain(), launchAgentPath()]);
  launchctl(['kickstart', '-k', serviceTarget()]);
}

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

function resolveRunnerPath(): string {
  const argv = process.argv[1];
  if (argv && existsSync(argv)) return argv;
  return fileURLToPath(import.meta.url).replace(/setup\.js$/, 'cli.js');
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export function runnerDisplayName(): string {
  return basename(resolveRunnerPath());
}
