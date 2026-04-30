import type { BotmemClient } from '../client.js';
import { formatMemoryList, formatMemory, formatStats } from '../format.js';
import { writeFileSync } from 'fs';

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

  if (args[1] === 'raw') {
    let out: string | undefined;
    let metadataOut: string | undefined;
    let variant: 'original' | 'thumbnail' = 'original';

    for (let i = 2; i < args.length; i++) {
      const a = args[i];
      if (a === '--out') out = args[++i];
      else if (a === '--metadata-out') metadataOut = args[++i];
      else if (a === '--variant') {
        const next = args[++i];
        if (next !== 'original' && next !== 'thumbnail') {
          console.error('Error: --variant must be original or thumbnail');
          process.exit(1);
        }
        variant = next;
      }
    }

    const raw = await client.getMemoryRaw(id);
    if (out) {
      const file = await client.getMemoryRawFile(id, variant);
      writeFileSync(out, file.buffer);
      if (metadataOut) writeFileSync(metadataOut, JSON.stringify(raw, null, 2));
      const result = {
        ok: true,
        out,
        bytes: file.buffer.length,
        contentType: file.contentType,
        fileName: file.fileName,
        metadataOut: metadataOut ?? null,
      };
      if (json) console.log(JSON.stringify(result, null, 2));
      else console.log(`Raw ${variant} written to ${out} (${file.buffer.length} bytes).`);
    } else if (json) {
      console.log(JSON.stringify(raw, null, 2));
    } else {
      console.log(JSON.stringify(raw, null, 2));
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
