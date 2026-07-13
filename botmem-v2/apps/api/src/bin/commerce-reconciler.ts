import {
  startCommerceReconcilerFromEnvironment,
  type CommerceWorkerTelemetryPort,
} from '../commerce/worker.js';

const shutdown = new AbortController();
const stop = () => shutdown.abort('process_shutdown');
process.once('SIGINT', stop);
process.once('SIGTERM', stop);

const telemetry: CommerceWorkerTelemetryPort = {
  report: ({ code }) => {
    process.stdout.write(`${JSON.stringify({ component: 'commerce_reconciler', event: code })}\n`);
  },
};

try {
  await startCommerceReconcilerFromEnvironment(process.env, shutdown.signal, telemetry);
} catch {
  process.stderr.write(
    `${JSON.stringify({
      component: 'commerce_reconciler',
      event: 'fatal_error',
    })}\n`,
  );
  process.exitCode = 1;
}
