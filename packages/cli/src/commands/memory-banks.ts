import type { BotmemClient } from '../client.js';
import { formatMemoryBanks } from '../format.js';

export const memoryBanksHelp = `
  botmem memory-banks -- Manage memory banks

  USAGE
    botmem memory-banks                          List all banks
    botmem memory-banks create <name>            Create a new bank
    botmem memory-banks rename <id> <name>       Rename a bank
    botmem memory-banks delete <id>              Delete a bank

  OPTIONS
    --json    Output raw JSON

  EXAMPLES
    botmem memory-banks
    botmem memory-banks create "Work"
    botmem memory-banks rename abc123 "Personal"
    botmem memory-banks delete abc123
`.trim();

export async function runMemoryBanks(client: BotmemClient, args: string[], json: boolean) {
  const sub = args[0];

  if (sub === 'create') {
    const name = args[1];
    if (!name) {
      console.error('Error: create requires a name\n');
      console.log(memoryBanksHelp);
      process.exit(1);
    }
    const result = await client.createMemoryBank(name);
    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Created memory bank "${result.name}" (${result.id})`);
    }
    return;
  }

  if (sub === 'rename') {
    const id = args[1];
    const name = args[2];
    if (!id || !name) {
      console.error('Error: rename requires <id> and <name>\n');
      console.log(memoryBanksHelp);
      process.exit(1);
    }
    const result = await client.renameMemoryBank(id, name);
    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Renamed memory bank to "${result.name}" (${result.id})`);
    }
    return;
  }

  if (sub === 'delete') {
    const id = args[1];
    if (!id) {
      console.error('Error: delete requires an id\n');
      console.log(memoryBanksHelp);
      process.exit(1);
    }
    await client.deleteMemoryBank(id);
    if (json) {
      console.log(JSON.stringify({ ok: true, deleted: id }, null, 2));
    } else {
      console.log(`Deleted memory bank ${id}`);
    }
    return;
  }

  // Default: list
  const result = await client.listMemoryBanks();
  const banks = result.memoryBanks || result;

  if (json) {
    console.log(JSON.stringify(banks, null, 2));
  } else {
    console.log(formatMemoryBanks(Array.isArray(banks) ? banks : []));
  }
}
