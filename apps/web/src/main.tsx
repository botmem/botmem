import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { initPostHog } from './lib/posthog';
import './index.css';

// Defer analytics init until after first paint to improve FCP/LCP
if (typeof requestIdleCallback === 'function') {
  requestIdleCallback(() => initPostHog());
} else {
  setTimeout(() => initPostHog(), 1);
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
