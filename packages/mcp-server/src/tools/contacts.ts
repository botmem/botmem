import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BotmemClient, Contact, Memory } from '../client.js';

function formatContact(c: Contact): string {
  const lines: string[] = [];
  lines.push(`ID: ${c.id}`);
  lines.push(`Name: ${c.displayName}`);
  if (c.identifiers?.length) {
    lines.push('Identifiers:');
    for (const ident of c.identifiers) {
      lines.push(`  ${ident.identifierType}: ${ident.identifierValue}${ident.connectorType ? ` (from ${ident.connectorType})` : ''}`);
    }
  }
  // avatars is a JSON string in the DB
  if (c.avatars) {
    try {
      const avatarArr = JSON.parse(c.avatars);
      if (Array.isArray(avatarArr) && avatarArr.length > 0) {
        lines.push(`Avatars: ${avatarArr.length} available`);
      }
    } catch { /* skip */ }
  }
  if (c.metadata) {
    try {
      const meta = typeof c.metadata === 'string' ? JSON.parse(c.metadata) : c.metadata;
      if (meta && Object.keys(meta).length > 0) {
        lines.push(`Metadata: ${JSON.stringify(meta)}`);
      }
    } catch { /* skip */ }
  }
  lines.push(`Created: ${c.createdAt}`);
  return lines.join('\n');
}

function formatMemoryBrief(m: Memory, idx: number): string {
  const lines: string[] = [];
  lines.push(`${idx + 1}. [${m.sourceType}/${m.connectorType}] ${m.text.slice(0, 200)}${m.text.length > 200 ? '...' : ''}`);
  if (m.eventTime) lines.push(`   Time: ${m.eventTime}`);
  lines.push(`   ID: ${m.id}`);
  return lines.join('\n');
}

export function registerContactTools(server: McpServer, client: BotmemClient): void {
  server.tool(
    'contact_search',
    'Search contacts by name, email, phone, or any identifier.',
    {
      query: z.string().describe('Search query (name, email, phone number, etc.)'),
    },
    async ({ query }) => {
      try {
        const contacts = await client.searchContacts(query);
        if (contacts.length === 0) {
          return { content: [{ type: 'text', text: `No contacts found for "${query}".` }] };
        }

        const text = [
          `Found ${contacts.length} contacts for "${query}":`,
          '',
          ...contacts.map((c, i) => `--- ${i + 1} ---\n${formatContact(c)}`),
        ].join('\n');

        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error searching contacts: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    },
  );

  server.tool(
    'contact_get',
    'Get detailed information about a specific contact.',
    {
      id: z.string().describe('The contact UUID'),
    },
    async ({ id }) => {
      try {
        const contact = await client.getContact(id);
        return { content: [{ type: 'text', text: formatContact(contact) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error getting contact: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    },
  );

  server.tool(
    'contact_memories',
    'Get all memories linked to a specific contact.',
    {
      contactId: z.string().describe('The contact UUID'),
      limit: z.number().default(50).describe('Maximum number of memories to return'),
    },
    async ({ contactId, limit }) => {
      try {
        let memories = await client.getContactMemories(contactId);
        if (limit && memories.length > limit) {
          memories = memories.slice(0, limit);
        }

        if (memories.length === 0) {
          return { content: [{ type: 'text', text: `No memories linked to contact ${contactId}.` }] };
        }

        const text = [
          `Found ${memories.length} memories for contact ${contactId}:`,
          '',
          ...memories.map((m, i) => formatMemoryBrief(m, i)),
        ].join('\n');

        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error getting contact memories: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    },
  );
}
