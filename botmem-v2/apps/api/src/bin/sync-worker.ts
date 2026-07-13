import { runHostedSyncWorkerFromEnvironment } from '../sync-worker-runtime.js';

const shutdown = new AbortController();
const stop = () => shutdown.abort('process_shutdown');
process.once('SIGINT', stop);
process.once('SIGTERM', stop);

try {
  await runHostedSyncWorkerFromEnvironment(process.env, shutdown.signal);
} catch {
  console.error(JSON.stringify({ component: 'hosted_sync_worker', event: 'fatal_error' }));
  process.exitCode = 1;
}
