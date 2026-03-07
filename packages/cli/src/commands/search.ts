import type { BotmemClient } from '../client.js';
import { formatSearchResults } from '../format.js';

export const searchHelp = `
  ${bold('botmem search')} -- Search memories semantically

  USAGE
    botmem search <query> [options]

  OPTIONS
    --source <type>      Filter by source (email, message, photo, location)
    --connector <type>   Filter by connector (gmail, slack, whatsapp, imessage, locations)
    --contact <id>       Filter by contact UUID
    --limit <n>          Max results (default: 20)
    --json               Output raw JSON

  EXAMPLES
    botmem search "dinner plans"
    botmem search "meeting" --connector gmail --limit 5
    botmem search "photos from dubai" --source photo --json
`.trim();

function bold(s: string) { return `\x1b[1m${s}\x1b[0m`; }

export async function runSearch(client: BotmemClient, args: string[], json: boolean) {
  // Collect query words (everything that's not a flag or flag value)
  const query: string[] = [];
  const filters: Record<string, string> = {};
  let limit: number | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--source' || a === '--connector' || a === '--contact') {
      const val = args[++i];
      if (!val) { console.error(`Missing value for ${a}`); process.exit(1); }
      const key = a.slice(2); // 'source' -> sourceType, etc
      if (key === 'source') filters['sourceType'] = val;
      else if (key === 'connector') filters['connectorType'] = val;
      else if (key === 'contact') filters['contactId'] = val;
    } else if (a === '--limit') {
      limit = parseInt(args[++i], 10);
    } else if (!a.startsWith('--')) {
      query.push(a);
    }
  }

  const queryStr = query.join(' ');
  if (!queryStr) {
    console.error('Error: search requires a query\n');
    console.log(searchHelp);
    process.exit(1);
  }

  const results = await client.searchMemories(queryStr, Object.keys(filters).length ? filters : undefined, limit);

  if (json) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    console.log(formatSearchResults(results));
  }
}
