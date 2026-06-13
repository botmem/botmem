import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { IntegrationsTab } from '../IntegrationsTab';

describe('IntegrationsTab', () => {
  it('wraps config paths and stacks agent cards on mobile', () => {
    render(<IntegrationsTab />);

    expect(screen.getByText('.claude/settings.json → mcpServers')).toHaveClass('break-all');
    expect(screen.getByText('~/.codeium/windsurf/mcp_config.json')).toHaveClass('break-all');
    const agentGrid = screen.getByText('Claude Desktop').closest('.grid');
    expect(agentGrid).toBeInTheDocument();
    expect(agentGrid).toHaveClass('grid-cols-1');
  });
});
