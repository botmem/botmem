#!/usr/bin/env node

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createHash, randomBytes } from 'crypto';
import { createServer } from 'http';
import { exec } from 'child_process';
import { createInterface } from 'readline';
import { BotmemClient, BotmemApiError } from './client.js';
import { formatStatus, toonify } from './format.js';
import { runSearch, searchHelp } from './commands/search.js';
import { runMemories, runMemory, runStats } from './commands/memories.js';
import { runContacts, runContact } from './commands/contacts.js';
import { runJobs, runSync, runRetry, runAccounts, runPipeline } from './commands/jobs.js';
import { runTimeline, timelineHelp } from './commands/timeline.js';
import { runEntities, runRelated, entitiesHelp, relatedHelp } from './commands/entities.js';
import { runVersion, versionHelp } from './commands/version.js';
import { runAsk, runContext, askHelp, contextHelp } from './commands/agent.js';
import { runMemoryBanks, memoryBanksHelp } from './commands/memory-banks.js';
import { runInstallSkill } from './commands/install-skill.js';

const DEFAULT_API_URL = 'http://localhost:12412/api';

const CONFIG_DIR = join(homedir(), '.botmem');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

interface StoredConfig {
  apiUrl?: string;
  apiKey?: string;
  token?: string;
  recoveryKey?: string;
}

interface ParsedGlobalArgs {
  apiUrl: string;
  token: string;
  apiKeyToken: string;
  jwtToken: string;
  json: boolean;
  toon: boolean;
  help: boolean;
  rest: string[];
}

function loadConfig(): StoredConfig {
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function saveConfig(cfg: StoredConfig) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

function isJwtLike(token: string | undefined): token is string {
  return !!token && token.split('.').length === 3;
}

function isExpiredJwt(token: string): boolean {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) as {
      exp?: number;
    };
    return typeof payload.exp === 'number' && payload.exp <= Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

function requiresFullAuth(command: string | undefined, args: string[]): boolean {
  if (!command) return false;
  if (command === 'sync') return !!args[0];
  if (command === 'memory' && args[1] === 'delete') return true;
  if (command === 'memory-banks' && ['create', 'rename', 'delete'].includes(args[0] || '')) {
    return true;
  }
  if (command === 'pipeline' && args[0] === 'repair') return true;
  return false;
}

function requireFullAuthToken(command: string, token: string) {
  if (!isJwtLike(token)) {
    console.error(`Error: botmem ${command} requires full authentication.`);
    console.error('Run `botmem login`, then retry this command.');
    process.exit(1);
  }

  if (isExpiredJwt(token)) {
    console.error(
      `Error: botmem ${command} requires a fresh login token, but the stored token is expired.`,
    );
    console.error('Run `botmem login`, then retry this command.');
    process.exit(1);
  }
}

function storeToken(token: string) {
  const cfg = loadConfig();
  cfg.token = token;
  saveConfig(cfg);
}

async function restoreRecoveryKey(
  apiUrl: string,
  token: string | undefined,
  recoveryKey: string | undefined,
) {
  if (!token || !recoveryKey) return;

  const unlockClient = new BotmemClient(apiUrl);
  unlockClient.setToken(token);
  await unlockClient.submitRecoveryKey(recoveryKey);
}

function warnRecoveryKeyRestoreFailure(err: unknown) {
  const detail =
    err instanceof BotmemApiError && err.body && typeof err.body === 'object'
      ? (err.body as { message?: string }).message
      : err instanceof Error
        ? err.message
        : String(err);
  console.error(`Warning: stored recovery key was not accepted${detail ? ` (${detail})` : ''}.`);
  console.error(
    'Login succeeded, but encrypted memories may stay hidden until you run `botmem config set-recovery-key <key>`.',
  );
  console.error('Run `botmem config clear-recovery-key` to remove the invalid saved recovery key.');
}

const HELP = `
  botmem -- Query and manage your personal memory system

  USAGE
    botmem <command> [options]

  COMMANDS
    login                   Authenticate and store token
    search <query>          Search memories semantically
    ask <query>             Natural language query (agent)
    context <contactId>     Full contact context (agent)
    timeline                Query memories by time range
    related <id>            Find memories related to a given memory
    entities search <q>     Search extracted entities (people, orgs, topics)
    entities graph <value>  Show entity graph with relationships
    memories                List recent memories
    memory <id>             Get or delete a memory
    memory-banks            Manage memory banks (list/create/rename/delete)
    stats                   Memory count breakdown by source/connector
    contacts                List contacts
    contacts search <query> Search contacts by name/email/phone
    contact <id>            Get contact details or their memories
    status                  Dashboard overview (memories, pipeline, connectors)
    version                 Show API build info and uptime
    jobs                    List sync/pipeline jobs
    sync <accountId>        Trigger a connector sync
    retry                   Retry all failed jobs and memories
    pipeline                Raw-event debt, repair, and log summaries
    accounts                List connected accounts
    install-skill           Install Claude Code skill in current project

  SETUP
    botmem config set-host <url>   Set API host (e.g. localhost:12412, api.botmem.xyz)
    botmem config set-key <key>    Store an API key (bm_sk_...)
    botmem config set-recovery-key <key>  Store recovery key for E2EE
    botmem config show             Show current config
    botmem login                   Log in via browser (OAuth) and store JWT

  GLOBAL OPTIONS
    --api-key <key>   API key (env: BOTMEM_API_KEY) — preferred for agents
    --token <jwt>     JWT token (env: BOTMEM_TOKEN) — from email/password login
    --api-url <url>   API base URL override (env: BOTMEM_API_URL, default: http://localhost:12412/api)
    --json            Output raw JSON (for piping to jq or scripts)
    --toon            Tool-optimized output: flattened JSON for LLM agents
    -h, --help        Show help (use with any command for details)

  EXAMPLES
    botmem search "coffee with Ahmed last week"
    botmem search "meeting" --connector gmail --limit 5
    botmem contacts search "Amr"
    botmem contact abc123 memories
    botmem status
    botmem sync abc123
    botmem timeline --from 2025-01-01 --to 2025-01-31
    botmem related abc123-def456
    botmem entities search "Assad"
    botmem ask "what did Ahmed say?" --json
    botmem memory-banks
    botmem search "project update" --json | jq '.[].text'
`.trim();

const COMMAND_HELP: Record<string, string> = {
  search: searchHelp,
  ask: askHelp,
  context: contextHelp,
  version: versionHelp,
  'memory-banks': memoryBanksHelp,
  timeline: timelineHelp,
  related: relatedHelp,
  entities: entitiesHelp,
  memories: `
  botmem memories -- List recent memories

  USAGE
    botmem memories [options]

  OPTIONS
    --limit <n>          Max results (default: 50)
    --offset <n>         Skip first N results
    --source <type>      Filter by source (email, message, photo, location)
    --connector <type>   Filter by connector (gmail, slack, whatsapp, imessage, locations)
    --json               Output raw JSON
`.trim(),
  memory: `
  botmem memory -- Get or delete a memory

  USAGE
    botmem memory <id>           Get a memory by ID
    botmem memory <id> delete    Delete a memory
    botmem memory <id> raw       Fetch raw event metadata via Botmem
    botmem memory <id> raw --out <path> [--variant original|thumbnail]
                                  Download connector-backed raw asset via Botmem
`.trim(),
  stats: `
  botmem stats -- Memory count breakdown

  USAGE
    botmem stats [--json]
`.trim(),
  contacts: `
  botmem contacts -- List or search contacts

  USAGE
    botmem contacts [options]          List contacts
    botmem contacts search <query>     Search contacts

  OPTIONS
    --limit <n>     Max results (default: 50)
    --offset <n>    Skip first N results
    --json          Output raw JSON
`.trim(),
  contact: `
  botmem contact -- Get contact details

  USAGE
    botmem contact <id>              Get contact details
    botmem contact <id> memories     List contact's memories
`.trim(),
  status: `
  botmem status -- Dashboard overview

  USAGE
    botmem status [--json]
`.trim(),
  jobs: `
  botmem jobs -- List sync/pipeline jobs

  USAGE
    botmem jobs [--account <id>] [--json]
`.trim(),
  sync: `
  botmem sync -- Trigger a connector sync

  USAGE
    botmem sync <accountId>
`.trim(),
  retry: `
  botmem retry -- Retry all failed jobs and memories

  USAGE
    botmem retry [--json]
`.trim(),
  accounts: `
  botmem accounts -- List connected accounts

  USAGE
    botmem accounts [--json]
`.trim(),
  pipeline: `
  botmem pipeline -- Inspect and repair pipeline state

  USAGE
    botmem pipeline debt [--connector <type>] [--source <type>] [--json]
    botmem pipeline repair [--limit <n>] [--connector <type>] [--source <type>] [--json]
    botmem pipeline logs [--json]
`.trim(),
};

function parseGlobalArgs(argv: string[]): ParsedGlobalArgs {
  const storedCfg = loadConfig();
  let apiUrl = process.env['BOTMEM_API_URL'] || storedCfg.apiUrl || DEFAULT_API_URL;
  let token = '';
  let explicitApiKey = '';
  let explicitJwt = '';
  let json = false;
  let toon = false;
  let help = false;
  const rest: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--api-url') {
      apiUrl = argv[++i];
    } else if (a === '--api-key') {
      explicitApiKey = argv[++i];
      token = explicitApiKey;
    } else if (a === '--token') {
      explicitJwt = argv[++i];
      token = explicitJwt;
    } else if (a === '--json') {
      json = true;
    } else if (a === '--toon') {
      toon = true;
      json = true; // toon implies json
    } else if (a === '--help' || a === '-h') {
      help = true;
    } else {
      rest.push(a);
    }
  }

  const apiKeyToken = explicitApiKey || process.env['BOTMEM_API_KEY'] || storedCfg.apiKey || '';
  const jwtToken = explicitJwt || process.env['BOTMEM_TOKEN'] || storedCfg.token || '';

  // Resolve read-token order: explicit flag > env var > stored config.
  // API keys are preferred for read-only agent use; JWTs are selected later for full-auth commands.
  if (!token) {
    token =
      process.env['BOTMEM_API_KEY'] ||
      process.env['BOTMEM_TOKEN'] ||
      storedCfg.apiKey ||
      storedCfg.token ||
      '';
  }

  return { apiUrl, token, apiKeyToken, jwtToken, json, toon, help, rest };
}

const configHelp = `
  botmem config -- Manage CLI configuration

  USAGE
    botmem config show                  Show current config
    botmem config set-host <url>        Set API host (e.g. localhost:12412, api.botmem.xyz)
    botmem config set-key <key>         Store API key (bm_sk_...)
    botmem config set-recovery-key <k>  Store recovery key for E2EE
    botmem config clear-recovery-key    Remove saved recovery key
    botmem config clear                 Reset config to defaults

  EXAMPLES
    botmem config set-host localhost:12412
    botmem config set-host api.botmem.xyz
    botmem config set-key bm_sk_abc123def456
    botmem config set-recovery-key oasULlqb...
    botmem config clear-recovery-key
    botmem config show
`.trim();

function runConfig(args: string[]) {
  const sub = args[0];

  if (sub === 'show' || !sub) {
    const cfg = loadConfig();
    console.log(`Config: ${CONFIG_FILE}`);
    console.log(`  Host:    ${cfg.apiUrl || DEFAULT_API_URL} ${!cfg.apiUrl ? '(default)' : ''}`);
    console.log(
      `  API Key: ${cfg.apiKey ? cfg.apiKey.slice(0, 10) + '...' + cfg.apiKey.slice(-4) : '(not set)'}`,
    );
    console.log(`  Token:   ${cfg.token ? '(set)' : '(not set)'}`);
    console.log(`  Recovery Key: ${cfg.recoveryKey ? '(set)' : '(not set)'}`);
    return;
  }

  if (sub === 'set-host') {
    let host = args[1];
    if (!host) {
      console.error('Error: set-host requires a URL\n');
      console.log(configHelp);
      process.exit(1);
    }
    // Normalize: add https:// if no scheme, add /api suffix if missing
    if (!host.startsWith('http://') && !host.startsWith('https://')) {
      // localhost or 127.0.0.1 → http, everything else → https
      const isLocal = host.startsWith('localhost') || host.startsWith('127.0.0.1');
      host = `${isLocal ? 'http' : 'https'}://${host}`;
    }
    if (!host.endsWith('/api')) {
      host = host.replace(/\/+$/, '') + '/api';
    }
    const cfg = loadConfig();
    cfg.apiUrl = host;
    saveConfig(cfg);
    console.log(`API URL set to ${host}`);
    return;
  }

  if (sub === 'set-key') {
    const key = args[1];
    if (!key) {
      console.error('Error: set-key requires an API key\n');
      console.log(configHelp);
      process.exit(1);
    }
    const cfg = loadConfig();
    cfg.apiKey = key;
    saveConfig(cfg);
    console.log(`API key stored (${key.slice(0, 10)}...${key.slice(-4)})`);
    return;
  }

  if (sub === 'set-recovery-key') {
    const key = args[1];
    if (!key) {
      console.error('Error: set-recovery-key requires a recovery key\n');
      console.log(configHelp);
      process.exit(1);
    }
    const cfg = loadConfig();
    cfg.recoveryKey = key;
    saveConfig(cfg);
    console.log('Recovery key stored');
    return;
  }

  if (sub === 'clear-recovery-key') {
    const cfg = loadConfig();
    delete cfg.recoveryKey;
    saveConfig(cfg);
    console.log('Recovery key cleared');
    return;
  }

  if (sub === 'clear') {
    saveConfig({});
    console.log('Config cleared');
    return;
  }

  console.error(`Unknown config command: ${sub}\n`);
  console.log(configHelp);
  process.exit(1);
}

async function runStatus(client: BotmemClient, json: boolean) {
  const [stats, queues, { accounts }] = await Promise.all([
    client.getMemoryStats(),
    client.getQueueStats(),
    client.listAccounts(),
  ]);

  if (json) {
    console.log(JSON.stringify({ stats, queues, accounts }, null, 2));
  } else {
    console.log(formatStatus(stats, queues, accounts));
  }
}

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function runFirstTimeSetup(): Promise<void> {
  if (existsSync(CONFIG_FILE)) return;
  if (!process.stdin.isTTY) return; // non-interactive (piped, agent) — skip

  console.error("Welcome to Botmem CLI! Let's set up your connection.\n");
  console.error('  1) Self-hosted  (default: http://localhost:12412)');
  console.error('  2) Custom URL   (enter your own)');
  console.error('');
  const choice = await prompt('Choose [1/2] (default: 1): ');

  let apiUrl: string;
  if (choice === '2') {
    const custom = await prompt('Enter your Botmem API URL (e.g. https://botmem.example.com): ');
    if (!custom) {
      console.error('No URL provided, using default localhost.');
      apiUrl = DEFAULT_API_URL;
    } else {
      apiUrl = custom;
      if (!apiUrl.startsWith('http://') && !apiUrl.startsWith('https://')) {
        const isLocal = apiUrl.startsWith('localhost') || apiUrl.startsWith('127.0.0.1');
        apiUrl = `${isLocal ? 'http' : 'https'}://${apiUrl}`;
      }
      if (!apiUrl.endsWith('/api')) {
        apiUrl = apiUrl.replace(/\/+$/, '') + '/api';
      }
    }
  } else {
    apiUrl = DEFAULT_API_URL;
  }

  saveConfig({ apiUrl });
  console.error(`\nConfig saved to ${CONFIG_FILE}`);
  console.error(`API URL: ${apiUrl}\n`);
  console.error(
    'Next: run `botmem login` to authenticate, or `botmem config set-key <bm_sk_...>` to use an API key.\n',
  );
}

function openBrowser(url: string) {
  const platform = process.platform;
  const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'start' : 'xdg-open';
  exec(`${cmd} "${url}"`);
}

function generatePKCE(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = randomBytes(32).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
  return { codeVerifier, codeChallenge };
}

async function runLogin(client: BotmemClient, _args: string[], apiUrl: string) {
  // Browser-based OAuth login
  const { codeVerifier, codeChallenge } = generatePKCE();
  const state = randomBytes(16).toString('base64url');

  // Start local HTTP server on random port
  const { port, waitForCallback, close } = await startCallbackServer();
  const redirectUri = `http://localhost:${port}/callback`;

  try {
    // Create CLI auth session on the server
    const session = await client.createCliSession({
      codeChallenge,
      codeChallengeMethod: 'S256',
      redirectUri,
      state,
    });

    console.log('Opening browser for login...');
    console.log(`If it doesn't open, visit: ${session.loginUrl}`);
    openBrowser(session.loginUrl);

    // Wait for the callback
    console.log('Waiting for authentication...');
    const callbackParams = await waitForCallback();

    if (callbackParams.error) {
      throw new Error(`Authentication denied: ${callbackParams.error}`);
    }

    if (callbackParams.state !== state) {
      throw new Error('State mismatch — possible CSRF attack');
    }

    if (!callbackParams.code) {
      throw new Error('No authorization code received');
    }

    // Exchange code for tokens
    const result = await client.exchangeCliCode({
      code: callbackParams.code,
      codeVerifier,
      redirectUri,
    });

    storeToken(result.accessToken);
    const cfg = loadConfig();
    if (cfg.recoveryKey) {
      try {
        await restoreRecoveryKey(apiUrl, result.accessToken, cfg.recoveryKey);
        console.log('Recovery key submitted for E2EE decryption');
      } catch (err) {
        warnRecoveryKeyRestoreFailure(err);
      }
    }
    console.log(`\nLogged in as ${result.user.name} (${result.user.email})`);
    console.log(`Token stored in ${CONFIG_FILE}`);
  } finally {
    close();
  }
}

function startCallbackServer(): Promise<{
  port: number;
  waitForCallback: () => Promise<{ code?: string; state?: string; error?: string }>;
  close: () => void;
}> {
  return new Promise((resolve, reject) => {
    let callbackResolve: (params: { code?: string; state?: string; error?: string }) => void;
    const callbackPromise = new Promise<{ code?: string; state?: string; error?: string }>(
      (res) => {
        callbackResolve = res;
      },
    );

    const server = createServer((req, res) => {
      const url = new URL(req.url || '/', `http://localhost`);
      if (url.pathname === '/callback') {
        const code = url.searchParams.get('code') || undefined;
        const state = url.searchParams.get('state') || undefined;
        const error = url.searchParams.get('error') || undefined;

        // Send a nice HTML response to the browser
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!DOCTYPE html>
<html>
<head><title>Botmem CLI</title><style>
  body { font-family: monospace; display: flex; align-items: center; justify-content: center;
         min-height: 100vh; margin: 0; background: #111; color: #fff; }
  .box { text-align: center; border: 3px solid #333; padding: 2rem; max-width: 400px; }
  .ok { color: #a3e635; font-size: 2rem; font-weight: bold; }
  .err { color: #f87171; font-size: 2rem; font-weight: bold; }
</style></head>
<body><div class="box">
  ${error ? '<div class="err">Authentication Failed</div><p>Return to your terminal for details.</p>' : '<div class="ok">&#10003; Authenticated</div><p>You can close this window and return to your terminal.</p>'}
</div></body></html>`);

        callbackResolve!({ code, state, error });
      } else {
        res.writeHead(404);
        res.end('Not Found');
      }
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('Failed to start callback server'));
        return;
      }
      resolve({
        port: addr.port,
        waitForCallback: () => callbackPromise,
        close: () => {
          clearTimeout(timeout);
          server.close();
          server.unref();
        },
      });
    });

    server.on('error', reject);

    // Timeout after 5 minutes
    const timeout = setTimeout(
      () => {
        callbackResolve!({ error: 'timeout' });
        server.close();
      },
      5 * 60 * 1000,
    );
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const { apiUrl, token, jwtToken, json, toon, help, rest } = parseGlobalArgs(argv);

  // --toon: intercept JSON output and flatten for LLM consumption
  if (toon) {
    const origLog = console.log.bind(console);
    console.log = (...args: unknown[]) => {
      if (args.length === 1 && typeof args[0] === 'string') {
        try {
          const parsed = JSON.parse(args[0]);
          origLog(toonify(parsed));
          return;
        } catch {
          /* not JSON, pass through */
        }
      }
      origLog(...args);
    };
  }

  const command = rest[0];
  const commandArgs = rest.slice(1);
  const fullAuthRequired = requiresFullAuth(command, commandArgs);

  if (help && !command) {
    console.log(HELP);
    return;
  }

  if (help && command && COMMAND_HELP[command]) {
    console.log(COMMAND_HELP[command]);
    return;
  }

  if (!command) {
    console.log(HELP);
    return;
  }

  // First-time setup prompt (interactive only)
  if (command !== 'config') {
    await runFirstTimeSetup();
  }

  // Commands that don't need API access
  if (command === 'install-skill') {
    runInstallSkill();
    return;
  }

  const client = new BotmemClient(apiUrl);
  const selectedToken = fullAuthRequired ? jwtToken : token;
  if (fullAuthRequired) requireFullAuthToken(command, selectedToken);
  if (selectedToken) client.setToken(selectedToken);

  // Auto-submit recovery key if stored (needed for E2EE decryption)
  const storedCfg = loadConfig();
  const unlockTokens = [storedCfg.token, storedCfg.apiKey, token].filter(
    (value, index, values): value is string => !!value && values.indexOf(value) === index,
  );
  if (storedCfg.recoveryKey) {
    for (const unlockToken of unlockTokens) {
      try {
        await restoreRecoveryKey(apiUrl, unlockToken, storedCfg.recoveryKey);
        break;
      } catch {
        // Non-fatal — token may be expired or key may already be cached server-side
      }
    }
  }

  try {
    switch (command) {
      case 'config':
        if (help) {
          console.log(configHelp);
          return;
        }
        runConfig(commandArgs);
        return;
      case 'login':
        await runLogin(client, commandArgs, apiUrl);
        return;
      case 'version':
        await runVersion(client, json);
        break;
      case 'ask':
        await runAsk(client, commandArgs, json);
        break;
      case 'context':
        await runContext(client, commandArgs, json);
        break;
      case 'memory-banks':
        await runMemoryBanks(client, commandArgs, json);
        break;
      case 'search':
        if (help) {
          console.log(COMMAND_HELP['search']);
          return;
        }
        await runSearch(client, commandArgs, json);
        break;
      case 'memories':
        await runMemories(client, commandArgs, json);
        break;
      case 'memory':
        await runMemory(client, commandArgs, json);
        break;
      case 'stats':
        await runStats(client, json);
        break;
      case 'contacts':
        await runContacts(client, commandArgs, json);
        break;
      case 'contact':
        await runContact(client, commandArgs, json);
        break;
      case 'status':
        await runStatus(client, json);
        break;
      case 'jobs':
        await runJobs(client, commandArgs, json);
        break;
      case 'sync':
        await runSync(client, commandArgs, json);
        break;
      case 'retry':
        await runRetry(client, json);
        break;
      case 'accounts':
        await runAccounts(client, json);
        break;
      case 'pipeline':
        await runPipeline(client, commandArgs, json);
        break;
      case 'timeline':
        await runTimeline(client, commandArgs, json);
        break;
      case 'related':
        await runRelated(client, commandArgs, json);
        break;
      case 'entities':
        await runEntities(client, commandArgs, json);
        break;
      default:
        console.error(`Unknown command: ${command}\n`);
        console.log(HELP);
        process.exit(1);
    }
  } catch (err) {
    if (err instanceof BotmemApiError) {
      if (err.status === 0) {
        console.error(`Error: Cannot connect to Botmem API at ${apiUrl}`);
        console.error('Make sure the API server is running. For self-hosted: docker compose up -d');
      } else {
        console.error(`Error: API returned ${err.status} — ${err.message}`);
        if (err.body) console.error(JSON.stringify(err.body, null, 2));
      }
      process.exit(1);
    }
    throw err;
  }
}

main();
