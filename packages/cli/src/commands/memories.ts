import type { BotmemClient } from '../client.js';
import { formatMemoryList, formatMemory, formatStats } from '../format.js';

export async function runMemories(client: BotmemClient, args: string[], json: boolean) {
  let limit: number | undefined;
  let offset: number | undefined;
  let sourceType: string | undefined;
  let connectorType: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--limit') limit = parseInt(args[++i], 10);
    else if (a === '--offset') offset = parseInt(args[++i], 10);
    else if (a === '--source') sourceType = args[++i];
    else if (a === '--connector') connectorType = args[++i];
  }

  const result = await client.listMemories({ limit, offset, connectorType, sourceType });

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatMemoryList(result.items, result.total));
  }
}

export async function runMemory(client: BotmemClient, args: string[], json: boolean) {
  const id = args[0];
  if (!id) {
    console.error('Error: memory requires an ID');
    process.exit(1);
  }

  if (args[1] === 'delete') {
    const result = await client.deleteMemory(id);
    if (json) {
      console.log(JSON.stringify(result));
    } else {
      console.log('Memory deleted.');
    }
    return;
  }

  const memory = await client.getMemory(id);
  if (json) {
    console.log(JSON.stringify(memory, null, 2));
  } else {
    console.log(formatMemory(memory));
  }
}

export async function runStats(client: BotmemClient, json: boolean) {
  const stats = await client.getMemoryStats();
  if (json) {
    console.log(JSON.stringify(stats, null, 2));
  } else {
    console.log(formatStats(stats));
  }
}
