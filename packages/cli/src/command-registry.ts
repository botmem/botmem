import { AGENT_COMMANDS_BY_ID, type AgentCommandDefinition } from '@botmem/shared';

function plainBold(s: string) {
  return `\x1b[1m${s}\x1b[0m`;
}

function padRight(value: string, width: number): string {
  return value + ' '.repeat(Math.max(1, width - value.length));
}

export function renderCliHelp(commandId: string): string | null {
  const command = AGENT_COMMANDS_BY_ID[commandId]?.cli;
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

export function getRegisteredCommand(commandId: string): AgentCommandDefinition | undefined {
  return AGENT_COMMANDS_BY_ID[commandId];
}
