/** Minimal OpenClaw plugin API type declarations. */

export interface PluginApi {
  getConfig(): Record<string, unknown>;
  registerAgentTool(tool: AgentToolDef, opts?: { optional?: boolean }): void;
  on(event: string, handler: (...args: unknown[]) => unknown, opts?: { priority?: number }): void;
  logger: {
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
  };
}

export interface AgentToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (id: string, params: Record<string, unknown>) => Promise<ToolResult>;
}

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
}

export interface PluginConfig {
  apiUrl: string;
  apiKey: string;
  defaultLimit?: number;
  memoryBankId?: string;
  autoContext?: boolean;
}
