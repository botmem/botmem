#!/usr/bin/env node

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { BotmemClient, BotmemApiError } from './client.js';
import { formatStatus, toonify } from './format.js';
import { runSearch, searchHelp } from './commands/search.js';
import { runMemories, runMemory, runStats } from './commands/memories.js';
import { runContacts, runContact } from './commands/contacts.js';
import { runJobs, runSync, runRetry, runAccounts } from './commands/jobs.js';
import { runTimeline, timelineHelp } from './commands/timeline.js';
import { runEntities, runRelated, entitiesHelp, relatedHelp } from './commands/entities.js';
import { runVersion, versionHelp } from './commands/version.js';
import { runAsk, runContext, askHelp, contextHelp } from './commands/agent.js';
import { runMemoryBanks, memoryBanksHelp } from './commands/memory-banks.js';

const DEFAULT_API_URL = 'https://api.botmem.xyz/api';

const CONFIG_DIR = join(homedir(), '.botmem');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

interface StoredConfig {
  apiUrl?: string;
  apiKey?: string;
  token?: string;
  recoveryKey?: string;
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

function loadStoredToken(): string | null {
  const cfg = loadConfig();
  return cfg.apiKey || cfg.token || null;
}

function storeToken(token: string) {
  const cfg = loadConfig();
  cfg.token = token;
  saveConfig(cfg);
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
    accounts                List connected accounts

  SETUP
    botmem config set-host <url>   Set API host (e.g. localhost:12412, api.botmem.xyz)
    botmem config set-key <key>    Store an API key (bm_sk_...)
    botmem config set-recovery-key <key>  Store recovery key for E2EE
    botmem config show             Show current config
    botmem login                   Log in with email/password and store JWT

  GLOBAL OPTIONS
    --api-key <key>   API key (env: BOTMEM_API_KEY) — preferred for agents
    --token <jwt>     JWT token (env: BOTMEM_TOKEN) — from email/password login
    --api-url <url>   API base URL override (env: BOTMEM_API_URL, default: https://api.botmem.xyz/api)
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
};

function parseGlobalArgs(argv: string[]) {
  const storedCfg = loadConfig();
  let apiUrl = process.env['BOTMEM_API_URL'] || storedCfg.apiUrl || DEFAULT_API_URL;
  let token = process.env['BOTMEM_API_KEY'] || process.env['BOTMEM_TOKEN'] || '';
  let json = false;
  let toon = false;
  let help = false;
  const rest: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--api-url') {
      apiUrl = argv[++i];
    } else if (a === '--api-key') {
      token = argv[++i];
    } else if (a === '--token') {
      token = argv[++i];
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

  // Resolve: explicit flag > env var > stored config
  if (!token) token = loadStoredToken() || '';

  return { apiUrl, token, json, toon, help, rest };
}

const configHelp = `
  botmem config -- Manage CLI configuration

  USAGE
    botmem config show                  Show current config
    botmem config set-host <url>        Set API host (e.g. localhost:12412, api.botmem.xyz)
    botmem config set-key <key>         Store API key (bm_sk_...)
    botmem config set-recovery-key <k>  Store recovery key for E2EE
    botmem config clear                 Reset config to defaults

  EXAMPLES
    botmem config set-host localhost:12412
    botmem config set-host api.botmem.xyz
    botmem config set-key bm_sk_abc123def456
    botmem config set-recovery-key oasULlqb...
    botmem config show
`.trim();

function runConfig(args: string[]) {
  const sub = args[0];

  if (sub === 'show' || !sub) {
    const cfg = loadConfig();
    console.log(`Config: ${CONFIG_FILE}`);
    console.log(`  Host:    ${cfg.apiUrl || DEFAULT_API_URL} ${!cfg.apiUrl ? '(default)' : ''}`);
    console.log(`  API Key: ${cfg.apiKey ? cfg.apiKey.slice(0, 10) + '...' + cfg.apiKey.slice(-4) : '(not set)'}`);
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

async function runLogin(client: BotmemClient, args: string[]) {
  // Accept email/password as positional args or prompt-style from env
  let email = args[0] || process.env['BOTMEM_EMAIL'] || '';
  let password = args[1] || process.env['BOTMEM_PASSWORD'] || '';

  if (!email || !password) {
    // Read from stdin if not provided
    const readline = await import('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    const ask = (q: string): Promise<string> => new Promise(r => rl.question(q, r));
    if (!email) email = await ask('Email: ');
    if (!password) password = await ask('Password: ');
    rl.close();
  }

  const result = await client.login(email, password);
  storeToken(result.accessToken);
  console.log(`Logged in as ${result.user.name} (${result.user.email})`);
  console.log(`Token stored in ${CONFIG_FILE}`);
}

async function main() {
  const argv = process.argv.slice(2);
  const { apiUrl, token, json, toon, help, rest } = parseGlobalArgs(argv);

  // --toon: intercept JSON output and flatten for LLM consumption
  if (toon) {
    const origLog = console.log.bind(console);
    console.log = (...args: any[]) => {
      if (args.length === 1 && typeof args[0] === 'string') {
        try {
          const parsed = JSON.parse(args[0]);
          origLog(toonify(parsed));
          return;
        } catch { /* not JSON, pass through */ }
      }
      origLog(...args);
    };
  }

  const command = rest[0];
  const commandArgs = rest.slice(1);

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

  const client = new BotmemClient(apiUrl);
  if (token) client.setToken(token);

  // Auto-submit recovery key if stored (needed for E2EE decryption)
  const storedCfg = loadConfig();
  if (token && storedCfg.recoveryKey) {
    try {
      await client.submitRecoveryKey(storedCfg.recoveryKey);
    } catch {
      // Non-fatal — key may already be cached server-side
    }
  }

  try {
    switch (command) {
      case 'config':
        if (help) { console.log(configHelp); return; }
        runConfig(commandArgs);
        return;
      case 'login':
        await runLogin(client, commandArgs);
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
        if (help) { console.log(COMMAND_HELP['search']); return; }
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
        console.error('Make sure the API server is running (pnpm dev)');
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
