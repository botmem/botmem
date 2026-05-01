#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const cliRoot = resolve(here, '..');
const repoRoot = resolve(cliRoot, '../..');
const clientPath = resolve(cliRoot, 'src/client.ts');
const skillPath = resolve(repoRoot, '.agents/skills/botmem-cli/SKILL.md');
const installSkillPath = resolve(cliRoot, 'src/commands/install-skill.ts');

const clientSource = readFileSync(clientPath, 'utf8');

const typeNames = ['Memory', 'SearchResult', 'Contact', 'ConnectorAccount', 'Job', 'QueueStats'];

function extractInterface(name) {
  const start = clientSource.indexOf(`export interface ${name} `);
  if (start === -1) throw new Error(`Could not find interface ${name} in ${clientPath}`);

  const braceStart = clientSource.indexOf('{', start);
  if (braceStart === -1) throw new Error(`Could not find body for interface ${name}`);

  let depth = 0;
  for (let i = braceStart; i < clientSource.length; i++) {
    const ch = clientSource[i];
    if (ch === '{') depth++;
    if (ch === '}') depth--;
    if (depth === 0) {
      return clientSource.slice(start, i + 1).trim();
    }
  }

  throw new Error(`Could not find end of interface ${name}`);
}

function responseTypesMarkdown() {
  const interfaces = typeNames.map(extractInterface).join('\n\n');

  return `## Response Types

<!-- BEGIN GENERATED RESPONSE TYPES -->
Generated from \`packages/cli/src/client.ts\`. Run \`pnpm --filter @botmem/cli update-skill-types\` after changing CLI response types.

\`\`\`ts
${interfaces}
\`\`\`

### Command Response Map

- \`botmem search <query> --toon\`: \`{ items: SearchResult[]; fallback: boolean; resolvedEntities?: { contacts: { id: string; displayName: string }[]; topicWords: string[] }; diagnostics?: unknown }\`
- \`botmem memories --toon\`: \`{ items: Memory[]; total: number }\`
- \`botmem memory <id> --toon\`: \`Memory\`
- \`botmem contacts --toon\`: \`{ items: Contact[]; total: number }\`
- \`botmem contacts search <name> --toon\`: \`Contact[]\`
- \`botmem contact <id> --toon\`: \`Contact\`
- \`botmem contact <id> memories --toon\`: \`Memory[]\`
- \`botmem accounts --toon\`: \`{ accounts: ConnectorAccount[] }\`
- \`botmem jobs --toon\`: \`{ jobs: Job[] }\`
- \`botmem status --toon\`: dashboard summary object with memory, connector, queue, and health fields
- \`botmem ask <query> --toon\`: agent answer object, usually containing \`answer\`, optional \`conversationId\`, and source memory fields

### Useful Selectors

\`\`\`bash
botmem search "topic" --toon-fields items.id,items.text,items.eventTime,items.connectorType,items.sourceType
botmem search "topic" --debug --toon-fields items.id,items.score,items.weights.final,diagnostics
botmem contacts search "Name" --toon-fields id,displayName,identifiers.identifierType,identifiers.identifierValue
botmem accounts --toon-fields accounts.id,accounts.type,accounts.status,accounts.lastSync,accounts.memoriesIngested
botmem jobs --toon-fields jobs.id,jobs.connector,jobs.status,jobs.progress,jobs.total,jobs.error
\`\`\`

Use \`ask\` for synthesis, not primary verification. Prefer \`search --debug\` first when evidence quality matters.
<!-- END GENERATED RESPONSE TYPES -->`;
}

function replaceMarkdownSection(source, generated) {
  const sectionPattern =
    /## Response Types\n[\s\S]*?(?=\n## API Notes|\n## Typical Workflow|\n## Error Handling|$)/u;
  if (!sectionPattern.test(source)) {
    throw new Error('Could not find Response Types section to replace');
  }
  return source.replace(sectionPattern, generated);
}

function escapeForTemplateLiteral(markdown) {
  return markdown.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
}

const generated = responseTypesMarkdown();

if (existsSync(skillPath)) {
  const skill = readFileSync(skillPath, 'utf8');
  writeFileSync(skillPath, replaceMarkdownSection(skill, generated));
}

const installSkill = readFileSync(installSkillPath, 'utf8');
writeFileSync(installSkillPath, replaceMarkdownSection(installSkill, escapeForTemplateLiteral(generated)));

console.log('Updated botmem-cli skill response types from packages/cli/src/client.ts');
