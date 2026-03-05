#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './index.js';

const DEFAULT_API_URL = 'http://localhost:3001/api';

function getApiUrl(): string {
  // Check CLI args first
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--api-url' && args[i + 1]) {
      return args[i + 1];
    }
    if (args[i]?.startsWith('--api-url=')) {
      return args[i].split('=')[1];
    }
  }

  // Fall back to env var
  return process.env.BOTMEM_API_URL || DEFAULT_API_URL;
}

async function main(): Promise<void> {
  const apiUrl = getApiUrl();
  const server = createServer(apiUrl);
  const transport = new StdioServerTransport();

  await server.connect(transport);

  // Log to stderr so it does not interfere with stdio MCP transport
  console.error(`Botmem MCP server running (API: ${apiUrl})`);
}

main().catch((err) => {
  console.error('Fatal error starting Botmem MCP server:', err);
  process.exit(1);
});
