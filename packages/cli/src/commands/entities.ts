import type { BotmemClient } from '../client.js';
import { bold, dim, cyan } from '../format.js';

export const entitiesHelp = `
  ${bold('botmem entities')} -- Search and explore extracted entities

  USAGE
    botmem entities search <query>     Search entities (people, orgs, topics)
    botmem entities graph <value>      Show entity graph (memories + relationships)

  OPTIONS
    --limit <n>          Max results (default: 50)
    --type <type>        Filter by entity type (comma-separated, e.g. pet,person)
    --json               Output raw JSON

  EXAMPLES
    botmem entities search "Assad"
    botmem entities search "Google" --type organization
    botmem entities graph "Assad Mansoor"
    botmem entities search "Google" --json
`.trim();

export const relatedHelp = `
  ${bold('botmem related')} -- Find memories related to a given memory

  USAGE
    botmem related <memory-id>

  OPTIONS
    --limit <n>          Max results (default: 20)
    --json               Output raw JSON

  EXAMPLES
    botmem related abc123-def456
`.trim();

function truncate(text: string, maxLen: number): string {
  const oneLine = text.replace(/\n/g, ' ').trim();
  if (oneLine.length <= maxLen) return oneLine;
  return oneLine.slice(0, maxLen - 1) + '\u2026';
}

export async function runEntities(client: BotmemClient, args: string[], json: boolean) {
  const subcommand = args[0];
  const subArgs = args.slice(1);

  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    console.log(entitiesHelp);
    return;
  }

  let limit: number | undefined;
  let type: string | undefined;
  const queryParts: string[] = [];
  for (let i = 0; i < subArgs.length; i++) {
    if (subArgs[i] === '--limit') { limit = parseInt(subArgs[++i], 10); }
    else if (subArgs[i] === '--type') { type = subArgs[++i]; }
    else if (!subArgs[i].startsWith('--')) { queryParts.push(subArgs[i]); }
  }
  const query = queryParts.join(' ');

  switch (subcommand) {
    case 'search': {
      if (!query) { console.error('Error: entities search requires a query'); process.exit(1); }
      const result = await client.searchEntities(query, limit, type);

      if (json) { console.log(JSON.stringify(result, null, 2)); return; }

      if (!result.entities.length) { console.log(dim('No entities found.')); return; }

      console.log(bold(`Found ${result.total} entities matching "${query}"`));
      console.log('');
      for (const e of result.entities) {
        console.log(`  ${bold(e.value)} ${dim(`(${e.type})`)}  ${cyan(`${e.memoryCount} memories`)}  ${dim(e.connectors.join(', '))}`);
      }
      break;
    }

    case 'graph': {
      if (!query) { console.error('Error: entities graph requires an entity value'); process.exit(1); }
      const result = await client.getEntityGraph(query, limit);

      if (json) { console.log(JSON.stringify(result, null, 2)); return; }

      console.log(bold(`Entity: ${result.entity}`) + dim(` (${result.memoryCount} memories)`));

      if (result.contacts.length) {
        console.log('');
        console.log(bold('Matching Contacts:'));
        for (const c of result.contacts) {
          console.log(`  ${c.displayName} ${dim(c.id)}`);
        }
      }

      if (result.relatedEntities.length) {
        console.log('');
        console.log(bold('Co-occurring Entities:'));
        for (const e of result.relatedEntities.slice(0, 15)) {
          console.log(`  ${e.value} ${dim(`(${e.type})`)} ${dim(`×${e.count}`)}`);
        }
      }

      if (result.memories.length) {
        console.log('');
        console.log(bold('Recent Memories:'));
        for (const m of result.memories.slice(0, 10)) {
          console.log(`  ${dim(m.eventTime?.slice(0, 10) || '')} ${dim(`[${m.sourceType}/${m.connectorType}]`)} ${truncate(m.text, 80)}`);
          console.log(`           ${dim(m.id)}`);
        }
      }
      break;
    }

    default:
      console.error(`Unknown entities subcommand: ${subcommand}`);
      console.log(entitiesHelp);
      process.exit(1);
  }
}

export async function runRelated(client: BotmemClient, args: string[], json: boolean) {
  const memoryId = args.find(a => !a.startsWith('--'));
  if (!memoryId) { console.error('Error: related requires a memory ID'); process.exit(1); }

  let limit: number | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--limit') limit = parseInt(args[++i], 10);
  }

  const result = await client.getRelated(memoryId, limit);

  if (json) { console.log(JSON.stringify(result, null, 2)); return; }

  if (!result.items.length) { console.log(dim('No related memories found.')); return; }

  if (result.source) {
    console.log(bold('Source:') + ` ${truncate(result.source.text, 100)}`);
    console.log('');
  }

  console.log(bold(`${result.items.length} related memories:`));
  console.log('');
  for (const m of result.items) {
    const rel = m.relationship === 'linked' ? cyan('[linked]') : m.relationship === 'similar' ? dim('[similar]') : dim('[co-participant]');
    console.log(`  ${rel} ${dim(`[${m.sourceType}/${m.connectorType}]`)} ${truncate(m.text, 90)}`);
    console.log(`           ${dim(m.id)} ${dim(`score: ${m.score.toFixed(3)}`)}`);
  }
}
