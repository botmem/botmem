import type { BotmemClient } from '../client.js';
import { bold, dim } from '../format.js';

export const timelineHelp = `
  ${bold('botmem timeline')} -- Query memories by time range

  USAGE
    botmem timeline [options]

  OPTIONS
    --from <date>        Start date (ISO 8601, e.g. 2025-01-01)
    --to <date>          End date (ISO 8601, e.g. 2025-01-31)
    --query <text>       Filter by text content
    --connector <type>   Filter by connector
    --source <type>      Filter by source type
    --limit <n>          Max results (default: 50)
    --json               Output raw JSON

  EXAMPLES
    botmem timeline --from 2025-01-01 --to 2025-01-31
    botmem timeline --from 2025-06-01 --query "meeting"
    botmem timeline --connector gmail --limit 20
`.trim();

function truncate(text: string, maxLen: number): string {
  const oneLine = text.replace(/\n/g, ' ').trim();
  if (oneLine.length <= maxLen) return oneLine;
  return oneLine.slice(0, maxLen - 1) + '\u2026';
}

export async function runTimeline(client: BotmemClient, args: string[], json: boolean) {
  const params: Record<string, string | undefined> = {};
  let limit: number | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--from') params.from = args[++i];
    else if (a === '--to') params.to = args[++i];
    else if (a === '--query') params.query = args[++i];
    else if (a === '--connector') params.connectorType = args[++i];
    else if (a === '--source') params.sourceType = args[++i];
    else if (a === '--limit') limit = parseInt(args[++i], 10);
  }

  const result = await client.getTimeline({ ...params, limit } as any);

  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (!result.items.length) {
    console.log(dim('No memories found in the specified time range.'));
    return;
  }

  console.log(
    bold(`Timeline: ${result.total} memories`) +
      (params.from || params.to ? dim(` (${params.from || '...'} → ${params.to || '...'})`) : ''),
  );
  console.log('');

  let currentDate = '';
  for (const m of result.items) {
    const date = m.eventTime ? new Date(m.eventTime).toLocaleDateString() : 'unknown';
    if (date !== currentDate) {
      currentDate = date;
      console.log(bold(`\n--- ${date} ---`));
    }
    const time = m.eventTime ? new Date(m.eventTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
    console.log(
      `  ${dim(time)} ${dim(`[${m.sourceType}/${m.connectorType}]`)} ${truncate(m.text, 100)}`,
    );
    console.log(`         ${dim(m.id)}`);
  }

  console.log('');
  console.log(dim(`Showing ${result.items.length} of ${result.total}`));
}
