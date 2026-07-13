import { startProductionApiFromEnvironment } from '../production-api.js';
import { commerceApiExtensionFactory } from '../commerce/composition.js';
import { lifecycleApiExtensionFactory } from '../lifecycle/composition.js';

let app: Awaited<ReturnType<typeof startProductionApiFromEnvironment>> | undefined;
let closing = false;

const close = () => {
  if (closing) return;
  closing = true;
  void app?.close().catch(() => {
    process.exitCode = 1;
  });
};

process.once('SIGINT', close);
process.once('SIGTERM', close);

try {
  app = await startProductionApiFromEnvironment(process.env, [
    commerceApiExtensionFactory,
    lifecycleApiExtensionFactory,
  ]);
  if (closing) await app.close();
} catch {
  console.error(JSON.stringify({ component: 'api', event: 'startup_failed' }));
  process.exitCode = 1;
}
