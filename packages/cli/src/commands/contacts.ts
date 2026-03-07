import type { BotmemClient } from '../client.js';
import { formatContactList, formatContact, formatMemoryList } from '../format.js';

export async function runContacts(client: BotmemClient, args: string[], json: boolean) {
  // Check for "contacts search <query>"
  if (args[0] === 'search') {
    const query = args.slice(1).join(' ');
    if (!query) {
      console.error('Error: contacts search requires a query');
      process.exit(1);
    }
    const results = await client.searchContacts(query);
    if (json) {
      console.log(JSON.stringify(results, null, 2));
    } else {
      console.log(formatContactList(results, results.length));
    }
    return;
  }

  let limit: number | undefined;
  let offset: number | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--limit') limit = parseInt(args[++i], 10);
    else if (args[i] === '--offset') offset = parseInt(args[++i], 10);
  }

  const result = await client.listContacts({ limit, offset });
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatContactList(result.items, result.total));
  }
}

export async function runContact(client: BotmemClient, args: string[], json: boolean) {
  const id = args[0];
  if (!id) {
    console.error('Error: contact requires an ID');
    process.exit(1);
  }

  if (args[1] === 'memories') {
    const memories = await client.getContactMemories(id);
    if (json) {
      console.log(JSON.stringify(memories, null, 2));
    } else {
      console.log(formatMemoryList(memories, memories.length));
    }
    return;
  }

  const contact = await client.getContact(id);
  if (json) {
    console.log(JSON.stringify(contact, null, 2));
  } else {
    console.log(formatContact(contact));
  }
}
