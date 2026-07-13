import { startProjectionWorkerFromEnvironment } from '../projection-worker/composition.js';

let runtime: Awaited<ReturnType<typeof startProjectionWorkerFromEnvironment>> | undefined;
let closing = false;

const close = () => {
  if (closing) return;
  closing = true;
  void runtime?.app.close().catch(() => {
    process.exitCode = 1;
  });
};

process.once('SIGINT', close);
process.once('SIGTERM', close);

try {
  runtime = await startProjectionWorkerFromEnvironment(process.env);
  if (closing) await runtime.app.close();
} catch {
  console.error(
    JSON.stringify({
      component: 'projection-worker',
      level: 'error',
      code: 'startup_failed',
    }),
  );
  process.exitCode = 1;
}
