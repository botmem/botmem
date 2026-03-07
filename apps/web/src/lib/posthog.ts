import posthog from 'posthog-js';

const apiKey = import.meta.env.VITE_POSTHOG_API_KEY as string | undefined;
const apiHost = (import.meta.env.VITE_POSTHOG_HOST as string) || 'https://us.i.posthog.com';

export function initPostHog() {
  if (!apiKey) return;
  posthog.init(apiKey, {
    api_host: apiHost,
    capture_pageview: false, // we track manually on route change
  });
}

export function trackEvent(event: string, properties?: Record<string, unknown>): void {
  posthog.capture(event, properties);
}

export { posthog };
