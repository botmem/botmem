import { parseWorkspaceId } from '@botmem-v2/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { WorkspaceAuthorizationError } from '../search-api.js';
import type { SourceStatusReaderPort } from './postgres-source-status.js';

export interface SourceStatusWorkspaceAuthorizer {
  authorize(
    requestedWorkspaceId: string,
    credentials: {
      readonly authorizationHeader?: string;
      readonly cookieHeader?: string;
    },
  ): Promise<string>;
}

export interface SourceStatusApiDependencies {
  readonly sourceStatuses: SourceStatusReaderPort;
  readonly workspaceAuthorizer: SourceStatusWorkspaceAuthorizer;
}

interface SourceRouteParams {
  readonly workspaceId: string;
}

/** Adds the canonical authenticated `/sources` read endpoint to a Fastify app. */
export function registerSourceStatusApi(
  app: FastifyInstance,
  dependencies: SourceStatusApiDependencies,
): void {
  app.get<{ Params: SourceRouteParams }>(
    '/v2/workspaces/:workspaceId/sources',
    async (request, reply) => {
      let workspaceId: string;
      try {
        const requested = parseWorkspaceId(request.params.workspaceId);
        workspaceId = await dependencies.workspaceAuthorizer.authorize(
          requested,
          credentials(request),
        );
        if (workspaceId !== requested) {
          return reply.code(403).send(apiError('workspace_forbidden', 'Workspace access denied'));
        }
      } catch (error) {
        if (error instanceof ZodError) {
          return reply
            .code(400)
            .send(apiError('invalid_workspace_id', 'Workspace ID must be a UUID'));
        }
        if (error instanceof WorkspaceAuthorizationError) {
          return reply.code(error.status).send(apiError(error.code, error.message));
        }
        request.log.error({ code: 'authorization_failed' }, 'source status authorization failed');
        return reply.code(500).send(apiError('authorization_failed', 'Authorization failed'));
      }

      const requestAbort = requestAbortController(request);
      try {
        const statuses = await dependencies.sourceStatuses.list(
          workspaceId,
          requestAbort.controller.signal,
        );
        return reply.code(200).send(statuses);
      } catch {
        request.log.error({ code: 'source_status_failed' }, 'source status request failed');
        return reply.code(500).send(apiError('source_status_failed', 'Source status failed'));
      } finally {
        request.raw.off('aborted', requestAbort.onAbort);
      }
    },
  );
}

function requestAbortController(request: FastifyRequest): {
  readonly controller: AbortController;
  readonly onAbort: () => void;
} {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  request.raw.once('aborted', onAbort);
  return { controller, onAbort };
}

function credentials(request: FastifyRequest): {
  readonly authorizationHeader?: string;
  readonly cookieHeader?: string;
} {
  const authorization = request.headers.authorization;
  const cookie = request.headers.cookie;
  return {
    ...(authorization
      ? { authorizationHeader: Array.isArray(authorization) ? authorization[0] : authorization }
      : {}),
    ...(cookie ? { cookieHeader: Array.isArray(cookie) ? cookie[0] : cookie } : {}),
  };
}

function apiError(code: string, message: string) {
  return { error: { code, message } };
}
