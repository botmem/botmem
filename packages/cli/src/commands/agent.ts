import type { BotmemClient } from '../client.js';
import { formatAgentAnswer, formatAgentContext } from '../format.js';

export const askHelp = `
  botmem ask -- Natural language memory query

  USAGE
    botmem ask <query> [options]

  OPTIONS
    --summarize          Use LLM summarization (POST /agent/summarize)
    --conversation <id>  Continue a conversation (Typesense conversational RAG)
    --source <type>      Filter by source (email, message, photo, location)
    --connector <type>   Filter by connector (gmail, slack, whatsapp, imessage)
    --memory-bank <id>   Filter by memory bank ID
    --limit <n>          Max results (default: 10)
    --json               Output raw JSON

  EXAMPLES
    botmem ask "what did Ahmed say about the project?"
    botmem ask "summarize my week" --summarize
    botmem ask "photos from dubai" --source photo --json
    botmem ask "tell me more" --conversation abc123
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
  let conversationId: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--summarize') {
      summarize = true;
    } else if (a === '--conversation') {
      conversationId = args[++i];
    } else if (a === '--source' || a === '--connector') {
      const val = args[++i];
      if (!val) {
        console.error(`Missing value for ${a}`);
        process.exit(1);
      }
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

  let result: Record<string, unknown>;
  if (summarize) {
    result = await client.agentSummarize(queryStr, limit);
  } else {
    result = await client.agentAsk(
      queryStr,
      Object.keys(filters).length ? filters : undefined,
      limit,
      conversationId,
    );
  }

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    // Show conversation ID for follow-up queries
    const data = (result as Record<string, unknown>).data || result;
    const convId =
      (data as Record<string, unknown>).conversationId ||
      ((data as Record<string, { conversationId?: string }>).conversation || {}).conversationId;
    if (convId) {
      console.log(`\x1b[36m💬 Conversation: ${convId}\x1b[0m`);
      console.log(`\x1b[2m   Continue with: botmem ask "..." --conversation ${convId}\x1b[0m\n`);
    }
    console.log(formatAgentAnswer(data));
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
    console.log(formatAgentContext((result as Record<string, unknown>).data || result));
  }
}
