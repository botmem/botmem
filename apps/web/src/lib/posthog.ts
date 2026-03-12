/**
 * Lightweight PostHog proxy — does NOT import posthog-js at module level.
 * All calls are queued and flushed once the real SDK loads via initPostHog().
 * This keeps the 180KB analytics-vendor chunk off the critical path.
 */

type QueuedCall = { method: 'capture' | 'identify' | 'reset'; args: unknown[] };

const apiKey = import.meta.env.VITE_POSTHOG_API_KEY as string | undefined;
const apiHost = (import.meta.env.VITE_POSTHOG_HOST as string) || 'https://t.botmem.xyz';

let _posthog: typeof import('posthog-js').default | null = null;
const _queue: QueuedCall[] = [];

function enqueue(method: QueuedCall['method'], ...args: unknown[]) {
  if (_posthog) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (_posthog as any)[method](...args);
  } else {
    _queue.push({ method, args });
  }
}

function flush() {
  if (!_posthog) return;
  while (_queue.length) {
    const { method, args } = _queue.shift()!;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (_posthog as any)[method](...args);
  }
}

export async function initPostHog() {
  if (!apiKey) return;
  try {
    // Verify proxy is reachable before loading the 180KB SDK
    const probe = await fetch(`${apiHost}/decide?v=3`, { method: 'HEAD', mode: 'no-cors' }).catch(
      () => null,
    );
    if (!probe) {
      console.debug('[posthog] Proxy unreachable, skipping analytics init');
      return;
    }
  } catch {
    return;
  }
  const { default: posthog } = await import('posthog-js');
  posthog.init(apiKey, {
    api_host: apiHost,
    capture_pageview: false,

    session_recording: {
      maskAllInputs: true,
      maskTextSelector: '[data-ph-mask]',
      recordCrossOriginIframes: false,
      maskCapturedNetworkRequestFn: (request) => {
        if (request.requestHeaders) {
          const masked = { ...request.requestHeaders };
          for (const key of Object.keys(masked)) {
            const lower = key.toLowerCase();
            if (lower === 'authorization' || lower === 'cookie' || lower === 'x-api-key') {
              masked[key] = '***REDACTED***';
            }
          }
          request.requestHeaders = masked;
        }
        if (request.responseBody) {
          const url = request.name || '';
          if (
            url.includes('/api/memory') ||
            url.includes('/api/contacts') ||
            url.includes('/api/me')
          ) {
            request.responseBody = '***REDACTED***';
          }
        }
        if (request.requestBody) {
          const body = typeof request.requestBody === 'string' ? request.requestBody : '';
          if (
            body.includes('password') ||
            body.includes('recoveryKey') ||
            body.includes('refreshToken')
          ) {
            request.requestBody = '***REDACTED***';
          }
        }
        return request;
      },
    },

    autocapture: true,
    enable_heatmaps: true,
    capture_exceptions: true,
    capture_pageleave: true,
  });

  _posthog = posthog;
  flush();
}

/** Proxy object — safe to use before posthog loads. Calls are queued. */
export const posthog = {
  capture(event: string, properties?: Record<string, unknown>) {
    enqueue('capture', event, properties);
  },
  identify(userId: string, properties?: Record<string, unknown>) {
    enqueue('identify', userId, properties);
  },
  reset() {
    enqueue('reset');
  },
};

export function identifyUser(userId: string, properties?: Record<string, unknown>): void {
  if (!apiKey) return;
  posthog.identify(userId, properties);
}

export function trackEvent(event: string, properties?: Record<string, unknown>): void {
  posthog.capture(event, properties);
}

export function resetUser(): void {
  if (!apiKey) return;
  posthog.reset();
}
