import { parseSearchRequest, parseWorkspaceId } from '@botmem-v2/contracts';
import type { SearchApplicationService } from '@botmem-v2/sdk';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import {
  SearchCapacityUnavailableError,
  SearchRateLimitExceededError,
} from './search/rate-limited-search.js';

export interface WorkspaceAuthorizer {
  authorize(requestedWorkspaceId: string, credentials: WorkspaceCredentials): Promise<string>;
}

export interface WorkspaceCredentials {
  readonly authorizationHeader?: string;
  readonly cookieHeader?: string;
}

export interface SearchApiDependencies {
  readonly search: SearchApplicationService;
  readonly workspaceAuthorizer: WorkspaceAuthorizer;
}

interface SearchRouteParams {
  workspaceId: string;
}

interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
  };
}

/** Builds the production Fastify driving adapter around the search port. */
export function buildSearchApi(dependencies: SearchApiDependencies): FastifyInstance {
  const app = Fastify({ logger: false });

  registerSearchApi(app, dependencies);
  return app;
}

/** Registers search on an existing runtime without changing its injected ports. */
export function registerSearchApi(app: FastifyInstance, dependencies: SearchApiDependencies): void {
  app.post<{ Params: SearchRouteParams }>(
    '/v2/workspaces/:workspaceId/search',
    async (request, reply) => {
      let workspaceId: string;
      try {
        const requestedWorkspaceId = parseWorkspaceId(request.params.workspaceId);
        workspaceId = await dependencies.workspaceAuthorizer.authorize(
          requestedWorkspaceId,
          workspaceCredentials(request),
        );
        if (workspaceId !== requestedWorkspaceId) {
          return reply.code(403).send(error('workspace_forbidden', 'Workspace access denied'));
        }
      } catch (caught) {
        if (caught instanceof ZodError) {
          return reply.code(400).send(error('invalid_workspace_id', 'Workspace ID must be a UUID'));
        }
        if (caught instanceof WorkspaceAuthorizationError) {
          return reply.code(caught.status).send(error(caught.code, caught.message));
        }
        request.log.error({ code: 'authorization_failed' }, 'search authorization failed');
        return reply.code(500).send(error('authorization_failed', 'Authorization failed'));
      }

      let input: ReturnType<typeof parseSearchRequest>;
      try {
        input = parseSearchRequest(request.body);
      } catch (caught) {
        if (caught instanceof ZodError) {
          return reply
            .code(400)
            .send(
              error(
                'invalid_search_request',
                caught.issues[0]?.message ?? 'Invalid search request',
              ),
            );
        }
        return reply.code(400).send(error('invalid_search_request', 'Invalid search request'));
      }

      try {
        const response = await dependencies.search.search(workspaceId, input);
        return reply.code(200).send(response);
      } catch (caught) {
        if (caught instanceof SearchRateLimitExceededError) {
          reply.header('retry-after', String(caught.retryAfterSeconds));
          return reply
            .code(429)
            .send(error('search_rate_limited', 'Search capacity exceeded; retry later'));
        }
        if (caught instanceof SearchCapacityUnavailableError) {
          reply.header('retry-after', '1');
          return reply
            .code(503)
            .send(error('search_capacity_unavailable', 'Search is temporarily unavailable'));
        }
        request.log.error({ code: 'search_failed' }, 'search request failed');
        return reply.code(500).send(error('search_failed', 'Search failed'));
      }
    },
  );
}

export class WorkspaceAuthorizationError extends Error {
  constructor(
    readonly status: 401 | 402 | 403,
    readonly code: 'authentication_required' | 'subscription_required' | 'workspace_forbidden',
    message: string,
  ) {
    super(message);
    this.name = 'WorkspaceAuthorizationError';
  }
}

function workspaceCredentials(request: FastifyRequest): WorkspaceCredentials {
  const authorizationHeader = headerValue(request.headers.authorization);
  const cookieHeader = headerValue(request.headers.cookie);
  return {
    ...(authorizationHeader ? { authorizationHeader } : {}),
    ...(cookieHeader ? { cookieHeader } : {}),
  };
}

function headerValue(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : value?.[0];
}

function error(code: string, message: string): ErrorEnvelope {
  return { error: { code, message } };
}
