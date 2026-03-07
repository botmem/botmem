import type { BotmemClient } from '../client.js';
import { formatJobList, formatAccounts } from '../format.js';

export async function runJobs(client: BotmemClient, args: string[], json: boolean) {
  let accountId: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--account') accountId = args[++i];
  }

  const result = await client.listJobs(accountId);
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatJobList(result.jobs));
  }
}

export async function runSync(client: BotmemClient, args: string[], json: boolean) {
  const accountId = args[0];
  if (!accountId) {
    console.error('Error: sync requires an account ID');
    process.exit(1);
  }

  const result = await client.triggerSync(accountId);
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Sync triggered. Job ID: ${result.job.id}`);
  }
}

export async function runRetry(client: BotmemClient, json: boolean) {
  const [jobResult, memResult] = await Promise.all([
    client.retryFailedJobs(),
    client.retryFailedMemories(),
  ]);

  if (json) {
    console.log(JSON.stringify({ jobs: jobResult, memories: memResult }, null, 2));
  } else {
    console.log(`Retried ${jobResult.retried} failed sync jobs.`);
    console.log(`Re-enqueued ${memResult.enqueued} failed memories.`);
  }
}

export async function runAccounts(client: BotmemClient, json: boolean) {
  const result = await client.listAccounts();
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatAccounts(result.accounts));
  }
}
