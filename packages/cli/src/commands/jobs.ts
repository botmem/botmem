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

export async function runPipeline(client: BotmemClient, args: string[], json: boolean) {
  const sub = args[0] || 'debt';
  let limit: number | undefined;
  let connectorType: string | undefined;
  let sourceType: string | undefined;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--limit') limit = parseInt(args[++i], 10);
    if (args[i] === '--connector') connectorType = args[++i];
    if (args[i] === '--source') sourceType = args[++i];
  }

  if (sub === 'repair') {
    const result = await client.repairRawEventDebt({ limit, connectorType, sourceType });
    if (json) console.log(JSON.stringify(result, null, 2));
    else console.log(`Re-enqueued ${result.enqueued} raw event(s).`);
    return;
  }

  if (sub === 'logs') {
    const result = await client.getLogSummary();
    console.log(json ? JSON.stringify(result, null, 2) : JSON.stringify(result, null, 2));
    return;
  }

  const result = await client.getRawEventDebt({ connectorType, sourceType });
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.total === 0) {
    console.log('No raw-event extraction debt.');
  } else {
    console.log(`Raw-event debt: ${result.total}`);
    for (const group of result.groups) {
      console.log(
        `  ${group.connectorType.padEnd(12)} ${group.sourceType.padEnd(12)} ${String(group.count).padStart(8)} ${group.processingState}`,
      );
    }
  }
}
