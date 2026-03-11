import { useState } from 'react';
import { Modal } from '../ui/Modal';

interface Props {
  open: boolean;
  onClose: () => void;
}

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
    description: 'Paste into Settings → Developer → Edit Config',
  },
  {
    key: 'claude-code',
    label: 'Claude Code',
    description: 'Add to .claude/settings.json under mcpServers',
  },
  {
    key: 'cursor',
    label: 'Cursor',
    description: 'Add to .cursor/mcp.json',
  },
  {
    key: 'windsurf',
    label: 'Windsurf',
    description: 'Add to ~/.codeium/windsurf/mcp_config.json',
  },
] as const;

export function ConnectionInstructions({ open, onClose }: Props) {
  const [copied, setCopied] = useState<string | null>(null);

  const copyToClipboard = async (text: string, key: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(null), 2000);
  };

  return (
    <Modal open={open} onClose={onClose} title="Connect Your Tools">
      <p className="font-mono text-sm text-nb-muted mb-4">Your Botmem API endpoint:</p>

      <div className="flex items-center gap-3 border-3 border-nb-lime bg-nb-bg p-4 mb-6">
        <code className="font-mono text-lg text-nb-lime flex-1 select-all">{API_URL}</code>
        <button
          onClick={() => copyToClipboard(API_URL, 'url')}
          className="px-3 py-1 border-2 border-nb-border bg-nb-surface font-mono text-xs uppercase text-nb-muted hover:text-nb-text cursor-pointer shrink-0"
        >
          {copied === 'url' ? 'Copied!' : 'Copy'}
        </button>
      </div>

      <p className="font-mono text-sm text-nb-muted mb-3">Copy MCP config for your agent:</p>

      <div className="grid grid-cols-2 gap-3 mb-6">
        {agents.map((agent) => (
          <button
            key={agent.key}
            onClick={() => copyToClipboard(mcpConfig(), agent.key)}
            className="border-2 border-nb-border bg-nb-surface p-3 text-left hover:border-nb-lime cursor-pointer transition-colors group"
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

      <div className="border-t border-nb-border pt-4 mb-4">
        <p className="font-mono text-xs text-nb-muted mb-2">
          Or install the CLI for terminal access:
        </p>
        <div className="flex items-center gap-2">
          <code className="font-mono text-xs text-nb-text bg-nb-bg border border-nb-border px-3 py-2 flex-1">
            npm i -g @botmem/cli
          </code>
          <button
            onClick={() => copyToClipboard('npm install -g @botmem/cli', 'cli')}
            className="px-3 py-2 border border-nb-border bg-nb-surface font-mono text-[10px] uppercase text-nb-muted hover:text-nb-text cursor-pointer shrink-0"
          >
            {copied === 'cli' ? 'Copied!' : 'Copy'}
          </button>
        </div>
      </div>

      <div className="flex justify-end">
        <button
          onClick={onClose}
          className="px-6 py-2 border-3 border-nb-border bg-nb-lime font-display text-sm font-bold uppercase shadow-nb hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-none cursor-pointer transition-all"
        >
          Done
        </button>
      </div>
    </Modal>
  );
}
