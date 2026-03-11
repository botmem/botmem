import { useState } from 'react';

const API_URL = 'https://botmem.xyz';

function mcpConfig() {
  return JSON.stringify(
    {
      mcpServers: {
        botmem: {
          command: 'npx',
          args: ['-y', '@botmem/cli', 'mcp'],
          env: { BOTMEM_API_URL: API_URL },
        },
      },
    },
    null,
    2,
  );
}

const agents = [
  {
    key: 'claude-desktop',
    label: 'Claude Desktop',
    description: 'Settings → Developer → Edit Config',
  },
  {
    key: 'claude-code',
    label: 'Claude Code',
    description: '.claude/settings.json → mcpServers',
  },
  {
    key: 'cursor',
    label: 'Cursor',
    description: '.cursor/mcp.json',
  },
  {
    key: 'windsurf',
    label: 'Windsurf',
    description: '~/.codeium/windsurf/mcp_config.json',
  },
] as const;

export function IntegrationsTab() {
  const [copied, setCopied] = useState<string | null>(null);

  const copy = async (text: string, key: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(null), 2000);
  };

  return (
    <div>
      <h2 className="font-display text-lg font-bold uppercase tracking-wider text-nb-text mb-1">
        INTEGRATIONS
      </h2>
      <p className="font-mono text-xs text-nb-muted mb-6">
        Connect Botmem to your AI agents and tools.
      </p>

      {/* API URL */}
      <div className="mb-6">
        <label className="font-display text-sm font-bold uppercase tracking-wider text-nb-text block mb-2">
          API Endpoint
        </label>
        <div className="flex items-center gap-3 border-3 border-nb-lime bg-nb-bg p-3">
          <code className="font-mono text-base text-nb-lime flex-1 select-all">{API_URL}</code>
          <button
            onClick={() => copy(API_URL, 'url')}
            className="px-3 py-1 border-2 border-nb-border bg-nb-surface font-mono text-xs uppercase text-nb-muted hover:text-nb-text cursor-pointer shrink-0"
          >
            {copied === 'url' ? 'Copied!' : 'Copy'}
          </button>
        </div>
      </div>

      {/* MCP Config for agents */}
      <div className="mb-6">
        <label className="font-display text-sm font-bold uppercase tracking-wider text-nb-text block mb-2">
          MCP Server Config
        </label>
        <p className="font-mono text-xs text-nb-muted mb-3">
          Copy the config for your agent and paste it into the appropriate file:
        </p>
        <div className="grid grid-cols-2 gap-3">
          {agents.map((agent) => (
            <button
              key={agent.key}
              onClick={() => copy(mcpConfig(), agent.key)}
              className="border-2 border-nb-border bg-nb-surface p-3 text-left hover:border-nb-lime cursor-pointer transition-colors"
            >
              <span className="font-display text-sm font-bold uppercase text-nb-text block mb-0.5">
                {copied === agent.key ? 'Copied!' : agent.label}
              </span>
              <span className="font-mono text-[10px] text-nb-muted leading-tight block">
                {agent.description}
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* CLI */}
      <div className="border-t-3 border-nb-border pt-4">
        <label className="font-display text-sm font-bold uppercase tracking-wider text-nb-text block mb-2">
          CLI
        </label>
        <div className="flex items-center gap-2">
          <code className="font-mono text-xs text-nb-text bg-nb-bg border-2 border-nb-border px-3 py-2 flex-1">
            npm i -g @botmem/cli
          </code>
          <button
            onClick={() => copy('npm install -g @botmem/cli', 'cli')}
            className="px-3 py-2 border-2 border-nb-border bg-nb-surface font-mono text-xs uppercase text-nb-muted hover:text-nb-text cursor-pointer shrink-0"
          >
            {copied === 'cli' ? 'Copied!' : 'Copy'}
          </button>
        </div>
      </div>
    </div>
  );
}
