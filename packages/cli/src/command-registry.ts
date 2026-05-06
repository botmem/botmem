interface CliCommandDefinition {
  id: string;
  cli?: {
    name: string;
    summary: string;
    usage: string[];
    options?: Array<{ flag: string; description: string }>;
    examples?: string[];
  };
}

const CLI_COMMANDS = [
  {
    id: 'search',
    cli: {
      name: 'search',
      summary: 'Search memories semantically',
      usage: ['botmem search <query> [options]'],
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
  },
  {
    id: 'timeline',
    cli: {
      name: 'timeline',
      summary: 'Query memories by time range',
      usage: ['botmem timeline [options]'],
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
  },
  {
    id: 'activity',
    cli: {
      name: 'activity',
      summary: 'Query user-authored activity by time range',
      usage: ['botmem activity [options]'],
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
      usage: ['botmem memories [options]'],
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
  },
  {
    id: 'stats',
    cli: {
      name: 'stats',
      summary: 'Memory count breakdown',
      usage: ['botmem stats [--json]'],
    },
  },
] satisfies CliCommandDefinition[];

const CLI_COMMANDS_BY_ID = Object.fromEntries(
  CLI_COMMANDS.map((command) => [command.id, command]),
) as Record<string, CliCommandDefinition>;

function plainBold(s: string) {
  return `\x1b[1m${s}\x1b[0m`;
}

function padRight(value: string, width: number): string {
  return value + ' '.repeat(Math.max(1, width - value.length));
}

export function renderCliHelp(commandId: string): string | null {
  const command = CLI_COMMANDS_BY_ID[commandId]?.cli;
  if (!command) return null;

  const lines: string[] = [
    `  ${plainBold(`botmem ${command.name}`)} -- ${command.summary}`,
    '',
    '  USAGE',
    ...command.usage.map((usage) => `    ${usage}`),
  ];

  if (command.options?.length) {
    const width = Math.max(...command.options.map((option) => option.flag.length)) + 4;
    lines.push('', '  OPTIONS');
    for (const option of command.options) {
      lines.push(`    ${padRight(option.flag, width)}${option.description}`);
    }
  }

  if (command.examples?.length) {
    lines.push('', '  EXAMPLES');
    for (const example of command.examples) {
      lines.push(`    ${example}`);
    }
  }

  return lines.join('\n').trim();
}

export function registryCliHelp(commandId: string, fallback: string): string {
  return renderCliHelp(commandId) ?? fallback;
}

export function getRegisteredCommand(commandId: string): CliCommandDefinition | undefined {
  return CLI_COMMANDS_BY_ID[commandId];
}
