export type AgentToolArgType = 'string' | 'number' | 'boolean';

export interface AgentToolArg {
  type: AgentToolArgType;
  description: string;
  required?: boolean;
  default?: string | number | boolean;
  min?: number;
  max?: number;
}

export interface AgentToolSurface {
  name: string;
  summary: string;
  description: string;
  args: Record<string, AgentToolArg>;
  examples?: string[];
}

export interface AgentCommandDefinition {
  id: string;
  cli?: AgentToolSurface & {
    usage: string[];
    options?: Array<{ flag: string; description: string }>;
  };
  mcp?: AgentToolSurface;
}

export const SOURCE_TYPES = ['email', 'message', 'photo', 'location', 'file', 'note'] as const;

export const CONNECTOR_TYPES = [
  'gmail',
  'outlook',
  'slack',
  'whatsapp',
  'apple',
  'imessage',
  'telegram',
  'photos',
  'locations',
  'agent',
] as const;

const searchMcpDescription = `Search the user's personal memories using semantic vector search. Returns raw memory records ranked by a weighted score (semantic similarity, recency, importance, trust).

Use this tool when you need to:
- Find specific emails, messages, photos, locations, or events
- Look up what someone said or wrote
- Find memories from a specific time period or source
- Get raw data to answer factual questions

For latest/current-state questions, use precise filters and date ranges where possible, then inspect eventTime. source_type="location" means OwnTracks GPS pings. GPS-bearing photos use source_type="photo" with latitude/longitude in metadata.

Returns an array of memory objects, each containing: id, text, sourceType, connectorType, eventTime, factuality, entities, metadata, associated people, and score weights breakdown.

Tips:
- Use natural language queries; search is semantic, not keyword-only
- Combine filters to narrow results, for example connector_type="gmail" + source_type="email"
- Use connector_type="locations" for OwnTracks location pings
- For person-specific searches, first resolve the person/contact id from a previous result or contact lookup, then pass contact_id. A name in the query is only a hint unless contact_id is supplied.
- For exact identifiers such as booking references, PNRs, ticket numbers, invoice numbers, order IDs, and short all-caps codes, search the exact identifier first
- Results are sorted by weighted score, not pure event time`;

const askMcpDescription = `Ask a question about the user's personal memories. Retrieves relevant memories via semantic search, enriches them with contact and entity data, and returns the context needed to answer the question.

Use this tool when:
- The user asks a question that requires reasoning across multiple memories
- You need enriched context rather than raw search results
- The question involves "who", "when", "what happened", "where", or "summarize" patterns

Difference from search:
- search returns raw ranked results; use it for lookup and browsing
- ask returns enriched memories and optional synthesized answer/context; use it for answering questions

For person-specific questions, pass contact_id after resolving the correct contact. Do not rely on the person's name in query text alone; that is treated as a hint and may fall back to broader topic matches. For latest/current-state questions, prefer explicit date_from/date_to filters when available and inspect eventTime. For exact identifiers such as booking references, PNRs, ticket numbers, invoice numbers, order IDs, and short all-caps codes, use search first and ask only after retrieval. source_type="location" is OwnTracks; GPS-bearing photos are source_type="photo".`;

const searchArgs: Record<string, AgentToolArg> = {
  query: {
    type: 'string',
    required: true,
    description:
      'Natural language search query. Be descriptive; semantic search understands meaning, not just keywords.',
  },
  source_type: {
    type: 'string',
    description:
      'Filter by source type. Common values: email, message, photo, location. Note: location means OwnTracks GPS pings; photos with GPS remain photo.',
  },
  connector_type: {
    type: 'string',
    description:
      'Filter by connector. Common values: gmail, outlook, slack, whatsapp, imessage, telegram, photos, locations.',
  },
  contact_id: {
    type: 'string',
    description:
      'Hard-filter to a specific person/contact UUID from a previous result or contact lookup. Use this for person-specific queries instead of putting only the name in query.',
  },
  from_me: {
    type: 'boolean',
    description:
      'Only return messages authored by the Botmem user when connector metadata supports it.',
  },
  date_from: {
    type: 'string',
    description:
      'Start of event-time range as ISO 8601. Use for precise temporal filters; overrides natural-language dates in the query.',
  },
  date_to: {
    type: 'string',
    description:
      'End of event-time range as ISO 8601. Use for precise temporal filters; overrides natural-language dates in the query.',
  },
  text_max_length: {
    type: 'number',
    default: 500,
    min: 0,
    max: 2000,
    description: 'Maximum characters per text field in the response excerpt. Default: 500.',
  },
  limit: {
    type: 'number',
    default: 20,
    min: 1,
    max: 100,
    description: 'Maximum number of results to return. Default: 20.',
  },
};

const askArgs: Record<string, AgentToolArg> = {
  ...searchArgs,
  limit: {
    type: 'number',
    default: 20,
    min: 1,
    max: 100,
    description:
      'Maximum number of context memories to retrieve for answering. Default: 20. Use higher values for broad questions.',
  },
};

const limitArg = (defaultValue: number, description: string): AgentToolArg => ({
  type: 'number',
  default: defaultValue,
  min: 1,
  max: 100,
  description,
});

const textMaxLengthArg: AgentToolArg = {
  type: 'number',
  default: 500,
  min: 0,
  max: 2000,
  description: 'Maximum characters per text field in the response excerpt. Default: 500.',
};

const sourceFilterArg: AgentToolArg = {
  type: 'string',
  description:
    'Filter by source type. Common values: email, message, photo, location. Use sources/status to discover what is currently available.',
};

const connectorFilterArg: AgentToolArg = {
  type: 'string',
  description:
    'Filter by connector type. Common values: gmail, slack, whatsapp, imessage, photos, locations. Use sources/status to discover what is currently available.',
};

const fromMeArg: AgentToolArg = {
  type: 'boolean',
  description:
    'Only return messages authored by the Botmem user when connector metadata supports it.',
};

const statusMcpDescription = `Get a connector-agnostic Botmem status snapshot.

Returns memory counts, connected accounts, registered connector manifests, queue health, and the latest observed account update/sync time. Use this first when you need to understand what data sources exist, whether ingestion is healthy, or whether there is any data to query. This tool does not return encrypted memory text.`;

const sourcesMcpDescription = `List the data sources currently available to Botmem.

Returns source_type counts, connector_type counts, factuality counts, and registered connector manifest metadata. Use this before guessing source_type or connector_type filters. source_type="location" means an explicit location stream such as OwnTracks; GPS-bearing photos are still source_type="photo".`;

const listMcpDescription = `List recent memories directly from the memory store.

Use this for browsing, latest/current-state questions, or when weighted semantic search is the wrong sort. Results are sorted by eventTime descending by default and can be sorted by ingestTime descending. Supports connector_type and source_type filters. For "latest booking", "latest flight", and similar questions, list recent email memories for the relevant connector when exact search does not already answer the question.`;

const timelineMcpDescription = `Browse memories by event-time range.

Use this when the user gives a time window, asks what happened during a period, or when you need chronological context. Results are sorted by eventTime ascending. Use ISO 8601 from/to values for exact ranges.`;

const getMemoryMcpDescription = `Fetch one memory by id.

Use this after search, ask, list, or timeline returns a memory id and you need the full record with people, metadata, timestamps, and factuality.`;

const listArgs: Record<string, AgentToolArg> = {
  connector_type: connectorFilterArg,
  source_type: sourceFilterArg,
  from_me: fromMeArg,
  limit: limitArg(50, 'Maximum number of memories to return. Default: 50.'),
  offset: {
    type: 'number',
    default: 0,
    min: 0,
    max: 10000,
    description: 'Number of sorted results to skip. Default: 0.',
  },
  sort_by: {
    type: 'string',
    default: 'eventTime',
    description:
      'Sort field. Use eventTime for latest user events, or ingestTime for latest indexed records.',
  },
  text_max_length: textMaxLengthArg,
};

const timelineArgs: Record<string, AgentToolArg> = {
  from: {
    type: 'string',
    description: 'Start of event-time range as ISO 8601, for example 2026-04-01T00:00:00.000Z.',
  },
  to: {
    type: 'string',
    description: 'End of event-time range as ISO 8601, for example 2026-05-01T00:00:00.000Z.',
  },
  query: {
    type: 'string',
    description: 'Optional plain text filter applied inside the date range.',
  },
  connector_type: connectorFilterArg,
  source_type: sourceFilterArg,
  from_me: fromMeArg,
  limit: limitArg(50, 'Maximum number of timeline memories to return. Default: 50.'),
  text_max_length: textMaxLengthArg,
};

const getMemoryArgs: Record<string, AgentToolArg> = {
  id: {
    type: 'string',
    required: true,
    description: 'Memory UUID returned by search, ask, list, or timeline.',
  },
  text_max_length: textMaxLengthArg,
};

export const AGENT_COMMANDS = [
  {
    id: 'search',
    cli: {
      name: 'search',
      summary: 'Search memories semantically',
      description: 'Search memories semantically across emails, messages, photos, and locations.',
      usage: ['botmem search <query> [options]'],
      args: {},
      options: [
        {
          flag: '--source <type>',
          description: 'Filter by source (email, message, photo, location)',
        },
        {
          flag: '--connector <type>',
          description: 'Filter by connector (gmail, slack, whatsapp, imessage, locations)',
        },
        { flag: '--contact <id>', description: 'Filter by contact UUID' },
        { flag: '--from-me, --me', description: 'Only return messages authored by you' },
        { flag: '--memory-bank <id>', description: 'Filter by memory bank ID' },
        { flag: '--limit <n>', description: 'Max results (default: 20)' },
        { flag: '--debug', description: 'Include search planner and lane diagnostics' },
        { flag: '--json', description: 'Output raw JSON' },
      ],
      examples: [
        'botmem search "dinner plans"',
        'botmem search "meeting" --connector gmail --limit 5',
        'botmem search "photos from dubai" --source photo --json',
      ],
    },
    mcp: {
      name: 'search',
      summary: 'Search personal memories',
      description: searchMcpDescription,
      args: searchArgs,
      examples: [
        'meeting with Sarah about the product launch',
        'flights booked in January',
        'photos from the beach trip',
        'messages from Ahmed about the project',
        'latest location pings',
      ],
    },
  },
  {
    id: 'ask',
    cli: {
      name: 'ask',
      summary: 'Natural language query over memories',
      description: 'Ask a natural language question about memories.',
      usage: ['botmem ask <query> [options]'],
      args: {},
      options: [
        { flag: '--source <type>', description: 'Filter by source type' },
        { flag: '--connector <type>', description: 'Filter by connector type' },
        { flag: '--contact <id>', description: 'Hard-filter by contact/person UUID' },
        { flag: '--limit <n>', description: 'Max context memories (default: 20)' },
        { flag: '--conversation <id>', description: 'Continue a prior agent conversation' },
        { flag: '--json', description: 'Output raw JSON' },
      ],
      examples: ['botmem ask "what did Ahmed say?" --contact <id> --json'],
    },
    mcp: {
      name: 'ask',
      summary: 'Ask a question about memories',
      description: askMcpDescription,
      args: askArgs,
      examples: [
        'What did Ahmed say about the budget?',
        'Who emailed me about the conference last month?',
        'What photos did I take in Dubai?',
        'Where was I most recently?',
      ],
    },
  },
  {
    id: 'timeline',
    cli: {
      name: 'timeline',
      summary: 'Query memories by time range',
      description: 'Query memories by time range.',
      usage: ['botmem timeline [options]'],
      args: {},
      options: [
        { flag: '--from <date>', description: 'Start date (ISO 8601, e.g. 2025-01-01)' },
        { flag: '--to <date>', description: 'End date (ISO 8601, e.g. 2025-01-31)' },
        { flag: '--query <text>', description: 'Filter by text content' },
        { flag: '--connector <type>', description: 'Filter by connector' },
        { flag: '--source <type>', description: 'Filter by source type' },
        { flag: '--from-me, --me', description: 'Only return messages authored by you' },
        { flag: '--limit <n>', description: 'Max results (default: 50)' },
        { flag: '--json', description: 'Output raw JSON' },
      ],
      examples: [
        'botmem timeline --from 2025-01-01 --to 2025-01-31',
        'botmem timeline --from 2025-06-01 --query "meeting"',
        'botmem timeline --connector gmail --limit 20',
      ],
    },
    mcp: {
      name: 'timeline',
      summary: 'Browse memories by time range',
      description: timelineMcpDescription,
      args: timelineArgs,
      examples: [
        'from=2026-04-01T00:00:00.000Z to=2026-05-01T00:00:00.000Z',
        'source_type=location from=2026-05-02T00:00:00.000Z',
      ],
    },
  },
  {
    id: 'activity',
    cli: {
      name: 'activity',
      summary: 'Query user-authored activity by time range',
      description: 'Query user-authored activity by time range.',
      usage: ['botmem activity [options]'],
      args: {},
      options: [
        { flag: '--from <date>', description: 'Start date (ISO 8601, e.g. 2025-01-01)' },
        { flag: '--to <date>', description: 'End date (ISO 8601, e.g. 2025-01-31)' },
        { flag: '--query <text>', description: 'Filter by text content' },
        { flag: '--connector <type>', description: 'Filter by connector' },
        { flag: '--source <type>', description: 'Filter by source type' },
        { flag: '--limit <n>', description: 'Max results (default: 50)' },
        { flag: '--json', description: 'Output raw JSON' },
      ],
      examples: [
        'botmem activity --from 2025-01-01 --to 2025-01-31',
        'botmem activity --connector whatsapp --limit 20',
      ],
    },
  },
  {
    id: 'memories',
    cli: {
      name: 'memories',
      summary: 'List recent memories',
      description: 'List recent memories.',
      usage: ['botmem memories [options]'],
      args: {},
      options: [
        { flag: '--limit <n>', description: 'Max results (default: 50)' },
        { flag: '--offset <n>', description: 'Skip first N results' },
        {
          flag: '--source <type>',
          description: 'Filter by source (email, message, photo, location)',
        },
        {
          flag: '--connector <type>',
          description: 'Filter by connector (gmail, slack, whatsapp, imessage, locations)',
        },
        { flag: '--json', description: 'Output raw JSON' },
      ],
    },
    mcp: {
      name: 'list',
      summary: 'List recent memories',
      description: listMcpDescription,
      args: listArgs,
      examples: [
        'source_type=location sort_by=eventTime limit=1',
        'connector_type=gmail sort_by=ingestTime limit=10',
      ],
    },
  },
  {
    id: 'memory',
    cli: {
      name: 'memory',
      summary: 'Get one memory by id',
      description: 'Get one memory by id.',
      usage: ['botmem memory <id> [--json]'],
      args: {},
    },
    mcp: {
      name: 'get_memory',
      summary: 'Get one memory by id',
      description: getMemoryMcpDescription,
      args: getMemoryArgs,
      examples: ['id=8f6d8d1b-6a55-42aa-9e55-6a37a73ed5c2'],
    },
  },
  {
    id: 'stats',
    cli: {
      name: 'stats',
      summary: 'Memory count breakdown',
      description: 'Memory count breakdown by source, connector, and factuality.',
      usage: ['botmem stats [--json]'],
      args: {},
    },
  },
  {
    id: 'status',
    cli: {
      name: 'status',
      summary: 'Botmem service and ingestion status',
      description: 'Show Botmem service, account, connector, and queue status.',
      usage: ['botmem status [--json]'],
      args: {},
    },
    mcp: {
      name: 'status',
      summary: 'Botmem service and ingestion status',
      description: statusMcpDescription,
      args: {},
    },
  },
  {
    id: 'sources',
    mcp: {
      name: 'sources',
      summary: 'List available memory sources',
      description: sourcesMcpDescription,
      args: {},
    },
  },
] satisfies AgentCommandDefinition[];

export const AGENT_COMMANDS_BY_ID = Object.fromEntries(
  AGENT_COMMANDS.map((command) => [command.id, command]),
) as Record<string, AgentCommandDefinition>;

export function getAgentCommand(id: string): AgentCommandDefinition | undefined {
  return AGENT_COMMANDS_BY_ID[id];
}

export function listMcpCommands(): AgentCommandDefinition[] {
  return AGENT_COMMANDS.filter((command) => command.mcp);
}
