/**
 * OpenClaw plugin SDK types — matches the real OpenClaw plugin API.
 * See: openclaw/plugin-sdk
 */

export interface OpenClawPluginApi {
  pluginConfig: Record<string, unknown>;
  runtime: unknown;
  logger: {
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
  };
  resolvePath(path: string): string;
  registerTool(
    toolDef: OpenClawToolDef | ((ctx: ToolContext) => OpenClawToolDef | OpenClawToolDef[] | null),
    opts?: { name?: string; names?: string[] },
  ): void;
  registerCli(setup: (ctx: { program: unknown }) => void, opts?: { commands?: string[] }): void;
  registerService(service: { id: string; start: () => void; stop: () => void }): void;
  on(event: string, handler: (...args: unknown[]) => unknown): void;
}

export interface OpenClawToolDef {
  name: string;
  label?: string;
  description: string;
  parameters: unknown; // TypeBox schema
  execute: (toolCallId: string, params: Record<string, unknown>) => Promise<ToolResult>;
}

export interface ToolContext {
  config: unknown;
  sessionKey: string;
}

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  details?: Record<string, unknown>;
}

export interface PluginConfig {
  apiUrl: string;
  apiKey: string;
  defaultLimit: number;
  memoryBankId?: string;
  autoContext: boolean;
}
