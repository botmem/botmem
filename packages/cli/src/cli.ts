#!/usr/bin/env node

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { BotmemClient, BotmemApiError } from './client.js';
import { formatStatus } from './format.js';
import { runSearch, searchHelp } from './commands/search.js';
import { runMemories, runMemory, runStats } from './commands/memories.js';
import { runContacts, runContact } from './commands/contacts.js';
import { runJobs, runSync, runRetry, runAccounts } from './commands/jobs.js';
import { runTimeline, timelineHelp } from './commands/timeline.js';
import { runEntities, runRelated, entitiesHelp, relatedHelp } from './commands/entities.js';

const TOKEN_DIR = join(homedir(), '.botmem');
const TOKEN_FILE = join(TOKEN_DIR, 'token');

function loadStoredToken(): string | null {
  try { return readFileSync(TOKEN_FILE, 'utf-8').trim(); } catch { return null; }
}

function storeToken(token: string) {
  mkdirSync(TOKEN_DIR, { recursive: true });
  writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
}

const HELP = `
  botmem -- Query and manage your personal memory system

  USAGE
    botmem <command> [options]

  COMMANDS
    login                   Authenticate and store token
    search <query>          Search memories semantically
    timeline                Query memories by time range
    related <id>            Find memories related to a given memory
    entities search <q>     Search extracted entities (people, orgs, topics)
    entities graph <value>  Show entity graph with relationships
    memories                List recent memories
    memory <id>             Get or delete a memory
    stats                   Memory count breakdown by source/connector
    contacts                List contacts
    contacts search <query> Search contacts by name/email/phone
    contact <id>            Get contact details or their memories
    status                  Dashboard overview (memories, pipeline, connectors)
    jobs                    List sync/pipeline jobs
    sync <accountId>        Trigger a connector sync
    retry                   Retry all failed jobs and memories
    accounts                List connected accounts

  AUTHENTICATION
    botmem login                   Log in and store token in ~/.botmem/token
    --token <jwt>                  Pass token directly (env: BOTMEM_TOKEN)

  GLOBAL OPTIONS
    --api-url <url>   API base URL (env: BOTMEM_API_URL, default: http://localhost:12412/api)
    --json            Output raw JSON (for piping to jq or scripts)
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
    botmem search "project update" --json | jq '.[].text'
`.trim();

const COMMAND_HELP: Record<string, string> = {
  search: searchHelp,
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
  let apiUrl = process.env['BOTMEM_API_URL'] || 'http://localhost:12412/api';
  let token = process.env['BOTMEM_TOKEN'] || '';
  let json = false;
  let help = false;
  const rest: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--api-url') {
      apiUrl = argv[++i];
    } else if (a === '--token') {
      token = argv[++i];
    } else if (a === '--json') {
      json = true;
    } else if (a === '--help' || a === '-h') {
      help = true;
    } else {
      rest.push(a);
    }
  }

  // Resolve token: explicit flag > env var > stored file
  if (!token) token = loadStoredToken() || '';

  return { apiUrl, token, json, help, rest };
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
  console.log(`Token stored in ${TOKEN_FILE}`);
}

async function main() {
  const argv = process.argv.slice(2);
  const { apiUrl, token, json, help, rest } = parseGlobalArgs(argv);

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

  try {
    switch (command) {
      case 'login':
        await runLogin(client, commandArgs);
        return;
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
