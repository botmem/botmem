import { BrowserSessionSchema, type BrowserSession } from '@botmem-v2/contracts';
import type { FastifyInstance } from 'fastify';

export interface BrowserSessionReader {
  /** Resolves an opaque HttpOnly session cookie to the public browser session. */
  read(cookieHeader: string | undefined): Promise<BrowserSession | null>;
}

/** Registers the browser bootstrap endpoint. It can never return bearer tokens. */
export function registerSessionApi(app: FastifyInstance, sessions: BrowserSessionReader): void {
  app.get('/v2/session', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    reply.header('pragma', 'no-cache');
    try {
      const session = await sessions.read(headerValue(request.headers.cookie));
      if (!session) {
        return reply.code(401).send({
          error: { code: 'authentication_required', message: 'Sign in is required' },
        });
      }
      return reply.code(200).send(BrowserSessionSchema.parse(session));
    } catch {
      request.log.error({ code: 'session_read_failed' }, 'Browser session lookup failed');
      return reply.code(500).send({
        error: { code: 'session_unavailable', message: 'Session lookup failed' },
      });
    }
  });
}

function headerValue(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : value?.[0];
}
