export const WEB_SURFACE = (import.meta.env.VITE_WEB_SURFACE as string | undefined) || 'combined';

export const isLandingSurface = WEB_SURFACE === 'landing';
export const isAppSurface = WEB_SURFACE === 'app';

export const APP_ORIGIN =
  (import.meta.env.VITE_APP_URL as string | undefined) ||
  (typeof window !== 'undefined' ? window.location.origin : 'http://localhost:12412');

export const LANDING_ORIGIN =
  (import.meta.env.VITE_LANDING_URL as string | undefined) ||
  (typeof window !== 'undefined' ? window.location.origin : 'http://localhost:12412');

const CONFIGURED_API_ORIGIN = import.meta.env.VITE_API_ORIGIN as string | undefined;

export const API_ORIGIN =
  CONFIGURED_API_ORIGIN ||
  (typeof window !== 'undefined' ? window.location.origin : 'http://localhost:12412');

function defaultApiBase(origin: string, configuredOrigin: string | undefined): string {
  if (!configuredOrigin && typeof window !== 'undefined') {
    return '/api';
  }

  const normalized = origin.replace(/\/+$/, '');
  try {
    const url = new URL(normalized);
    return url.hostname === 'api.botmem.xyz' ? normalized : `${normalized}/api`;
  } catch {
    return `${normalized}/api`;
  }
}

export const API_BASE =
  (import.meta.env.VITE_API_BASE_URL as string | undefined) ||
  defaultApiBase(API_ORIGIN, CONFIGURED_API_ORIGIN);

function absoluteUrl(origin: string, path: string): string {
  return new URL(path, origin.endsWith('/') ? origin : `${origin}/`).toString();
}

export function appUrl(path = '/'): string {
  return absoluteUrl(APP_ORIGIN, path);
}

export function landingUrl(path = '/'): string {
  return absoluteUrl(LANDING_ORIGIN, path);
}

export function wsUrl(path = '/events'): string {
  const url = new URL(path, API_ORIGIN.endsWith('/') ? API_ORIGIN : `${API_ORIGIN}/`);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}
