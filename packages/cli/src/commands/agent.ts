import type { BotmemClient } from '../client.js';
import { formatAgentAnswer, formatAgentContext } from '../format.js';

export const askHelp = `
  botmem ask -- Natural language memory query

  USAGE
    botmem ask <query> [options]

  OPTIONS
    --summarize          Use LLM summarization (POST /agent/summarize)
    --source <type>      Filter by source (email, message, photo, location)
    --connector <type>   Filter by connector (gmail, slack, whatsapp, imessage)
    --memory-bank <id>   Filter by memory bank ID
    --limit <n>          Max results (default: 10)
    --json               Output raw JSON

  EXAMPLES
    botmem ask "what did Ahmed say about the project?"
    botmem ask "summarize my week" --summarize
    botmem ask "photos from dubai" --source photo --json
`.trim();

export const contextHelp = `
  botmem context -- Full context about a contact

  USAGE
    botmem context <contactId> [--json]

  EXAMPLES
    botmem context abc123-def456
    botmem context abc123-def456 --json
`.trim();

export async function runAsk(client: BotmemClient, args: string[], json: boolean) {
  const query: string[] = [];
  const filters: Record<string, string> = {};
  let limit: number | undefined;
  let summarize = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--summarize') {
      summarize = true;
    } else if (a === '--source' || a === '--connector') {
      const val = args[++i];
      if (!val) { console.error(`Missing value for ${a}`); process.exit(1); }
      if (a === '--source') filters['sourceType'] = val;
      else filters['connectorType'] = val;
    } else if (a === '--memory-bank') {
      filters['memoryBankId'] = args[++i];
    } else if (a === '--limit') {
      limit = parseInt(args[++i], 10);
    } else if (!a.startsWith('--')) {
      query.push(a);
    }
  }

  const queryStr = query.join(' ');
  if (!queryStr) {
    console.error('Error: ask requires a query\n');
    console.log(askHelp);
    process.exit(1);
  }

  let result: any;
  if (summarize) {
    result = await client.agentSummarize(queryStr, limit);
  } else {
    result = await client.agentAsk(queryStr, Object.keys(filters).length ? filters : undefined, limit);
  }

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatAgentAnswer(result.data || result));
  }
}

export async function runContext(client: BotmemClient, args: string[], json: boolean) {
  const contactId = args[0];
  if (!contactId) {
    console.error('Error: context requires a contact ID\n');
    console.log(contextHelp);
    process.exit(1);
  }

  const result = await client.agentContext(contactId);

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatAgentContext(result.data || result));
  }
}
