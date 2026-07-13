import { runLifecycleWorkerFromEnvironment } from '../lifecycle/composition.js';

const shutdown = new AbortController();
const stop = () => shutdown.abort('process_shutdown');
process.once('SIGINT', stop);
process.once('SIGTERM', stop);

try {
  await runLifecycleWorkerFromEnvironment(process.env, shutdown.signal);
} catch {
  process.stderr.write(
    `${JSON.stringify({
      component: 'lifecycle_worker',
      event: 'fatal_error',
    })}\n`,
  );
  process.exitCode = 1;
}
