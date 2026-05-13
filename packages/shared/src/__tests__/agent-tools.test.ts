import { describe, expect, it } from 'vitest';
import { AGENT_COMMANDS_BY_ID, listMcpCommands } from '../agent-tools.js';

describe('agent tool registry', () => {
  it('defines the existing MCP tools in the shared registry', () => {
    expect(
      listMcpCommands()
        .map((command) => command.mcp?.name)
        .sort(),
    ).toEqual(['ask', 'get_memory', 'list', 'search', 'sources', 'status', 'timeline']);
  });

  it('defines the existing CLI memory query commands in the shared registry', () => {
    expect(AGENT_COMMANDS_BY_ID.search?.cli?.name).toBe('search');
    expect(AGENT_COMMANDS_BY_ID.ask?.cli?.name).toBe('ask');
    expect(AGENT_COMMANDS_BY_ID.memories?.cli?.name).toBe('memories');
    expect(AGENT_COMMANDS_BY_ID.stats?.cli?.name).toBe('stats');
    expect(AGENT_COMMANDS_BY_ID.status?.cli?.name).toBe('status');
    expect(AGENT_COMMANDS_BY_ID.timeline?.cli?.name).toBe('timeline');
    expect(AGENT_COMMANDS_BY_ID.activity?.cli?.name).toBe('activity');
  });

  it('keeps location semantics visible in MCP descriptions', () => {
    const description = AGENT_COMMANDS_BY_ID.search?.mcp?.description ?? '';
    expect(description).toContain('connector_type="locations"');
    expect(description).toContain('source_type="photo"');
  });

  it('keeps contact filters available on search and ask MCP tools', () => {
    expect(AGENT_COMMANDS_BY_ID.search?.mcp?.args.contact_id).toBeDefined();
    expect(AGENT_COMMANDS_BY_ID.ask?.mcp?.args.contact_id).toBeDefined();
  });
});
