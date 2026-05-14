import { StrictMode } from 'react';
import { hydrateRoot, createRoot } from 'react-dom/client';
import { initPostHog } from './lib/posthog';
import { isLandingSurface } from './lib/urls';
import { detectAuthProvider } from './lib/auth-provider';
import './index.css';

async function start() {
  if (!isLandingSurface) {
    // Detect auth provider from API before rendering the app shell.
    await detectAuthProvider();
  }

  const { App } = isLandingSurface
    ? await import('./LandingApp').then((m) => ({ App: m.LandingApp }))
    : await import('./App');

  // Defer analytics init until after first paint to improve FCP/LCP
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(() => initPostHog());
  } else {
    setTimeout(() => initPostHog(), 1);
  }

  const rootEl = document.getElementById('root')!;
  const app = (
    <StrictMode>
      <App />
    </StrictMode>
  );

  // If the root has prerendered content, hydrate instead of full render
  if (rootEl.childNodes.length > 0) {
    hydrateRoot(rootEl, app);
  } else {
    createRoot(rootEl).render(app);
  }
}

start();
