import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BotmemClient } from '../client.js';

export function registerPipelineTools(server: McpServer, client: BotmemClient): void {
  server.tool(
    'connector_sync',
    'Trigger a sync job for a connected account. Returns the job details.',
    {
      accountId: z.string().describe('The account UUID to sync'),
    },
    async ({ accountId }) => {
      try {
        const job = await client.triggerSync(accountId);
        const text = [
          'Sync job started:',
          `  Job ID: ${job.id}`,
          `  Account: ${job.accountId}`,
          `  Status: ${job.status}`,
          `  Connector: ${job.connector}`,
        ].join('\n');
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error triggering sync: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    },
  );

  server.tool(
    'pipeline_status',
    'Get the current status of all processing queues (sync, embed, enrich).',
    {},
    async () => {
      try {
        const stats = await client.getQueueStats();
        const lines: string[] = ['Pipeline queue status:', ''];

        for (const [name, q] of Object.entries(stats)) {
          lines.push(`  ${name}:`);
          lines.push(`    Waiting: ${q.waiting}  Active: ${q.active}  Completed: ${q.completed}  Failed: ${q.failed}  Delayed: ${q.delayed}`);
        }

        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error getting pipeline status: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    },
  );
}
