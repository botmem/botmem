import { StrictMode } from 'react';
import { hydrateRoot, createRoot } from 'react-dom/client';
import { App } from './App';
import { initPostHog } from './lib/posthog';
import './index.css';

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
