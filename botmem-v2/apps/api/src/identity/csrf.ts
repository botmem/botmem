import type { FastifyInstance } from 'fastify';

export interface BrowserCsrfOptions {
  readonly cookieName: string;
  readonly allowedOrigins: readonly string[];
}

/** Origin protection for every cookie-authenticated unsafe request in the runtime. */
export function registerBrowserCsrfProtection(
  app: FastifyInstance,
  options: BrowserCsrfOptions,
): void {
  const allowed = new Set(options.allowedOrigins);
  app.addHook('onRequest', async (request, reply) => {
    if (!isUnsafe(request.method) || !hasCookie(request.headers.cookie, options.cookieName)) return;
    const origin = singleHeader(request.headers.origin);
    if (!origin || !allowed.has(origin)) {
      await reply.code(403).send({
        error: { code: 'csrf_rejected', message: 'Request origin is not allowed' },
      });
    }
  });
}

function isUnsafe(method: string): boolean {
  return method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
}

function hasCookie(header: string | undefined, name: string): boolean {
  if (!header || header.length > 8_192) return false;
  return header.split(';').some((part) => part.trim().startsWith(`${name}=`));
}

function singleHeader(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : value?.[0];
}
