import {
  EmailLoginAcceptedResponseSchema,
  EmailLoginCompleteRequestSchema,
  EmailLoginStartRequestSchema,
} from '@botmem-v2/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import {
  EmailLoginService,
  LoginChallengeRejectedError,
  LoginDeliveryUnavailableError,
  LoginInputError,
} from './email-login-service.js';

export interface EmailLoginApiOptions {
  readonly cookieName: string;
  readonly secureCookies: boolean;
  readonly allowedOrigins: readonly string[];
}

export function registerEmailLoginApi(
  app: FastifyInstance,
  login: EmailLoginService,
  options: EmailLoginApiOptions,
): void {
  const allowedOrigins = new Set(options.allowedOrigins);
  app.post('/v2/auth/email/start', async (request, reply) => {
    if (!trustedOrigin(request, allowedOrigins)) return forbidden(reply);
    try {
      const body = EmailLoginStartRequestSchema.parse(request.body);
      await login.begin(body.email, request.ip);
      return reply.code(202).send(
        EmailLoginAcceptedResponseSchema.parse({
          version: 2,
          status: 'accepted',
          message: 'If the account exists, a sign-in link has been sent',
        }),
      );
    } catch (error) {
      if (error instanceof LoginDeliveryUnavailableError) {
        return reply
          .code(503)
          .send(apiError('login_delivery_unavailable', 'Sign-in is unavailable'));
      }
      if (error instanceof LoginInputError || error instanceof ZodError) {
        return reply.code(400).send(apiError('invalid_request', 'Request is invalid'));
      }
      return reply.code(500).send(apiError('identity_unavailable', 'Identity operation failed'));
    }
  });

  app.post('/v2/auth/email/complete', async (request, reply) => {
    if (!trustedOrigin(request, allowedOrigins)) return forbidden(reply);
    try {
      const body = EmailLoginCompleteRequestSchema.parse(request.body);
      const session = await login.complete(body.token);
      reply.header('cache-control', 'no-store');
      reply.header(
        'set-cookie',
        `${options.cookieName}=${session.value}; Path=/; Expires=${new Date(session.expiresAt).toUTCString()}; HttpOnly; SameSite=Strict${options.secureCookies ? '; Secure' : ''}`,
      );
      return reply.code(204).send();
    } catch (error) {
      if (error instanceof LoginChallengeRejectedError) {
        return reply
          .code(401)
          .send(apiError('login_challenge_rejected', 'Sign-in link is invalid'));
      }
      if (error instanceof ZodError) {
        return reply.code(400).send(apiError('invalid_request', 'Request is invalid'));
      }
      return reply.code(500).send(apiError('identity_unavailable', 'Identity operation failed'));
    }
  });
}

function trustedOrigin(request: FastifyRequest, allowed: ReadonlySet<string>): boolean {
  const value = request.headers.origin;
  const origin = typeof value === 'string' ? value : value?.[0];
  return Boolean(origin && allowed.has(origin));
}

function forbidden(reply: FastifyReply) {
  return reply.code(403).send(apiError('csrf_rejected', 'Request origin is not allowed'));
}

function apiError(code: string, message: string) {
  return { error: { code, message } };
}
