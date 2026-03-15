/**
 * Botmem OpenClaw Plugin
 *
 * Personal memory search across emails, messages, photos, and more.
 * Connects to a Botmem API instance and provides 7 agent tools.
 */

import { OpenClawPluginApi, PluginConfig } from './types.js';
import { BotmemClient } from './client.js';
import { toonify } from './toon.js';
import { BOTMEM_SYSTEM_INSTRUCTIONS } from './templates/memory-instructions.js';

function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, envVar) => {
    return process.env[envVar] || '';
  });
}

const botmemPlugin = {
  id: 'botmem',
  name: 'Botmem Memory',
  description:
    'Personal memory backed by Botmem — semantic search across emails, messages, photos, and more.',

  configSchema: {
    parse(value: unknown): PluginConfig {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('botmem: config is required');
      }
      const raw = value as Record<string, unknown>;
      const apiKey = typeof raw.apiKey === 'string' ? resolveEnvVars(raw.apiKey) : '';
      if (!apiKey) {
        throw new Error('botmem: apiKey is required');
      }
      return {
        apiUrl:
          typeof raw.apiUrl === 'string' ? resolveEnvVars(raw.apiUrl) : 'http://localhost:12412',
        apiKey,
        defaultLimit: typeof raw.defaultLimit === 'number' ? raw.defaultLimit : 10,
        memoryBankId: typeof raw.memoryBankId === 'string' ? raw.memoryBankId : undefined,
        autoContext: raw.autoContext !== false,
      };
    },
  },

  register(api: OpenClawPluginApi) {
    const config = api.pluginConfig as unknown as PluginConfig;
    const client = new BotmemClient(config.apiUrl, config.apiKey);

    api.logger.info(`botmem: plugin registered (api: ${config.apiUrl})`);

    // ========================================================================
    // Tools — all use simple JSON schema objects (not TypeBox) since we don't
    // want to add @sinclair/typebox as a dependency.
    // OpenClaw accepts both TypeBox and plain JSON schema.
    // ========================================================================

    api.registerTool(
      {
        name: 'memory_search',
        label: 'Memory Search',
        description:
          'Semantic search across all memories (emails, messages, photos, locations). Returns ranked results with relevance scores.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Natural language search query' },
            sourceType: {
              type: 'string',
              description: 'Filter by source type (email, message, photo, location)',
            },
            connectorType: {
              type: 'string',
              description: 'Filter by connector (gmail, slack, whatsapp, imessage, photos-immich)',
            },
            contactId: { type: 'string', description: 'Filter by contact ID' },
            from: { type: 'string', description: 'Start date (ISO 8601)' },
            to: { type: 'string', description: 'End date (ISO 8601)' },
            limit: { type: 'number', description: 'Max results to return' },
          },
          required: ['query'],
        },
        async execute(_toolCallId, params) {
          const filters: Record<string, string> = {};
          if (params.sourceType) filters.sourceType = String(params.sourceType);
          if (params.connectorType) filters.connectorType = String(params.connectorType);
          if (params.contactId) filters.contactId = String(params.contactId);
          if (params.from) filters.from = String(params.from);
          if (params.to) filters.to = String(params.to);

          const results = await client.searchMemories(
            String(params.query),
            Object.keys(filters).length ? filters : undefined,
            (params.limit as number) ?? config.defaultLimit,
            config.memoryBankId,
          );
          return { content: [{ type: 'text' as const, text: toonify(results) }] };
        },
      },
      { name: 'memory_search' },
    );

    api.registerTool(
      {
        name: 'memory_ask',
        label: 'Memory Ask',
        description:
          'Natural language query with LLM-enriched answer synthesized from matching memories. Best for questions like "What did X say about Y?" Supports multi-turn conversations via conversationId.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Natural language question about memories' },
            limit: { type: 'number', description: 'Max source memories to consider' },
            conversationId: {
              type: 'string',
              description:
                'Continue a previous conversation. Pass the conversationId from a prior memory_ask response for follow-up questions.',
            },
          },
          required: ['query'],
        },
        async execute(_toolCallId, params) {
          const result = await client.agentAsk(
            String(params.query),
            undefined,
            (params.limit as number) ?? config.defaultLimit,
            params.conversationId as string | undefined,
          );
          return { content: [{ type: 'text' as const, text: toonify(result) }] };
        },
      },
      { name: 'memory_ask' },
    );

    api.registerTool(
      {
        name: 'memory_remember',
        label: 'Memory Remember',
        description:
          'Store a new memory in Botmem. Use for saving important facts, decisions, or information the user wants to remember.',
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'The memory text to store' },
            metadata: { type: 'object', description: 'Optional metadata (key-value pairs)' },
          },
          required: ['text'],
        },
        async execute(_toolCallId, params) {
          const result = await client.agentRemember(
            String(params.text),
            params.metadata as Record<string, unknown> | undefined,
          );
          return { content: [{ type: 'text' as const, text: toonify(result) }] };
        },
      },
      { name: 'memory_remember' },
    );

    api.registerTool(
      {
        name: 'memory_forget',
        label: 'Memory Forget',
        description:
          'Delete a specific memory by its ID. Use when the user explicitly asks to remove or forget something.',
        parameters: {
          type: 'object',
          properties: {
            memoryId: { type: 'string', description: 'The memory ID to delete' },
          },
          required: ['memoryId'],
        },
        async execute(_toolCallId, params) {
          const result = await client.agentForget(String(params.memoryId));
          return { content: [{ type: 'text' as const, text: toonify(result) }] };
        },
      },
      { name: 'memory_forget' },
    );

    api.registerTool(
      {
        name: 'memory_timeline',
        label: 'Memory Timeline',
        description:
          'Chronological view of memories. Useful for "what happened last week" or "show me recent emails from X".',
        parameters: {
          type: 'object',
          properties: {
            contactId: { type: 'string', description: 'Filter by contact ID' },
            connectorType: {
              type: 'string',
              description: 'Filter by connector (gmail, slack, whatsapp, etc.)',
            },
            sourceType: {
              type: 'string',
              description: 'Filter by source type (email, message, photo, location)',
            },
            days: { type: 'number', description: 'Number of days to look back (default: 7)' },
            limit: { type: 'number', description: 'Max results to return' },
          },
          required: [],
        },
        async execute(_toolCallId, params) {
          const result = await client.getTimeline({
            contactId: params.contactId as string | undefined,
            connectorType: params.connectorType as string | undefined,
            sourceType: params.sourceType as string | undefined,
            days: params.days as number | undefined,
            limit: (params.limit as number) ?? config.defaultLimit,
          });
          return { content: [{ type: 'text' as const, text: toonify(result) }] };
        },
      },
      { name: 'memory_timeline' },
    );

    api.registerTool(
      {
        name: 'person_context',
        label: 'Person Context',
        description:
          'Get full context about a person: contact details, identifiers, recent memories, and interaction stats.',
        parameters: {
          type: 'object',
          properties: {
            contactId: { type: 'string', description: 'The contact ID to look up' },
          },
          required: ['contactId'],
        },
        async execute(_toolCallId, params) {
          const result = await client.agentContext(String(params.contactId));
          return { content: [{ type: 'text' as const, text: toonify(result) }] };
        },
      },
      { name: 'person_context' },
    );

    api.registerTool(
      {
        name: 'people_search',
        label: 'People Search',
        description:
          'Find contacts by name, email, or phone number. Use before person_context to discover contact IDs.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Name, email, or phone to search for' },
            limit: { type: 'number', description: 'Max results to return' },
          },
          required: ['query'],
        },
        async execute(_toolCallId, params) {
          const result = await client.searchContacts(
            String(params.query),
            params.limit as number | undefined,
          );
          return { content: [{ type: 'text' as const, text: toonify(result) }] };
        },
      },
      { name: 'people_search' },
    );

    // ========================================================================
    // System prompt hook — inject memory instructions before agent starts
    // ========================================================================

    api.on('before_agent_start', async (event: unknown) => {
      const evt = event as { prompt?: string } | undefined;
      if (!evt) return;

      let instructions = BOTMEM_SYSTEM_INSTRUCTIONS;

      if (config.autoContext) {
        try {
          const status = (await client.getStatus()) as {
            data?: {
              memories?: { total?: number; byConnector?: Record<string, number> };
              contacts?: { total?: number };
            };
          };
          const mem = status.data?.memories;
          const contacts = status.data?.contacts;
          if (mem?.total) {
            const connectors = mem.byConnector
              ? Object.entries(mem.byConnector)
                  .map(([k, v]) => `${k}: ${v}`)
                  .join(', ')
              : '';
            instructions += `\n[Botmem: ${mem.total} memories${connectors ? ` (${connectors})` : ''}${contacts?.total ? `, ${contacts.total} contacts` : ''}]\n`;
          }
        } catch {
          // API unreachable — silently skip stats
        }
      }

      return { prependContext: instructions };
    });

    // ========================================================================
    // Service lifecycle
    // ========================================================================

    api.registerService({
      id: 'botmem',
      start: () => {
        api.logger.info(`botmem: started (api: ${config.apiUrl})`);
      },
      stop: () => {
        api.logger.info('botmem: stopped');
      },
    });
  },
};

export default botmemPlugin;
export { BotmemClient, BotmemApiError } from './client.js';
export type { OpenClawPluginApi, PluginConfig, ToolResult } from './types.js';
