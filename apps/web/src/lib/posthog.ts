import posthog from 'posthog-js';

const apiKey = import.meta.env.VITE_POSTHOG_API_KEY as string | undefined;
const apiHost = (import.meta.env.VITE_POSTHOG_HOST as string) || 'https://us.i.posthog.com';

export function initPostHog() {
  if (!apiKey) return;
  posthog.init(apiKey, {
    api_host: apiHost,
    capture_pageview: false, // we track manually on route change

    // Session replay (REPLAY-01, REPLAY-03)
    session_recording: {
      maskAllInputs: true,
      maskTextSelector: '[data-ph-mask]',
      recordCrossOriginIframes: false,
      // Mask auth headers in network recording (REPLAY-03)
      maskCapturedNetworkRequestFn: (request) => {
        if (request.requestHeaders) {
          const masked = { ...request.requestHeaders };
          for (const key of Object.keys(masked)) {
            if (key.toLowerCase() === 'authorization' || key.toLowerCase() === 'cookie') {
              masked[key] = '***REDACTED***';
            }
          }
          request.requestHeaders = masked;
        }
        return request;
      },
    },

    // Autocapture + heatmaps (HEAT-01, HEAT-03)
    autocapture: true,
    enable_heatmaps: true,

    // Error tracking (ERR-01)
    capture_exceptions: true,

    // Web analytics (WEB-03)
    capture_pageleave: true,
  });
}

export function identifyUser(
  userId: string,
  properties?: Record<string, unknown>,
): void {
  if (!apiKey) return;
  posthog.identify(userId, properties);
}

export function trackEvent(event: string, properties?: Record<string, unknown>): void {
  posthog.capture(event, properties);
}

export { posthog };
