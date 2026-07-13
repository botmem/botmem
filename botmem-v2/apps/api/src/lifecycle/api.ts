import {
  LifecycleJobListResponseSchema,
  LifecycleRequestResponseSchema,
  WorkspaceDeletionRequestSchema,
  parseWorkspaceId,
} from '@botmem-v2/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z, ZodError } from 'zod';
import {
  CredentialAuthenticationError,
  CredentialAuthorizationError,
  OpaqueCredentialService,
} from '../identity/credential-service.js';
import type { AuthenticatedPrincipal } from '../identity/domain.js';
import type { WorkspaceCredentials } from '../search-api.js';
import {
  LifecycleAuthorizationError,
  LifecycleExportNotReadyError,
  LifecycleInputError,
  LifecycleJobNotFoundError,
  type LifecycleJobView,
} from './domain.js';
import { WorkspaceLifecycleService } from './service.js';

interface WorkspaceParams {
  readonly workspaceId: string;
}

interface JobParams extends WorkspaceParams {
  readonly jobId: string;
}

export interface LifecycleApiOptions {
  readonly allowedOrigins: readonly string[];
}

export function registerLifecycleApi(
  app: FastifyInstance,
  credentials: OpaqueCredentialService,
  lifecycle: WorkspaceLifecycleService,
  options: LifecycleApiOptions,
): void {
  const allowedOrigins = new Set(options.allowedOrigins);

  app.get<{ Params: WorkspaceParams }>(
    '/v2/workspaces/:workspaceId/lifecycle/jobs',
    async (request, reply) => {
      try {
        const principal = await browserPrincipal(request, credentials);
        assertWorkspace(request.params.workspaceId, principal);
        noStore(reply);
        return reply.code(200).send(
          LifecycleJobListResponseSchema.parse({
            version: 2,
            items: (await lifecycle.list(principal)).map(publicJob),
          }),
        );
      } catch (error) {
        return lifecycleError(reply, error);
      }
    },
  );

  app.post<{ Params: WorkspaceParams }>(
    '/v2/workspaces/:workspaceId/lifecycle/exports',
    async (request, reply) => {
      if (!trustedOrigin(request, allowedOrigins)) return forbidden(reply);
      try {
        const principal = await browserPrincipal(request, credentials);
        assertWorkspace(request.params.workspaceId, principal);
        noStore(reply);
        return reply.code(202).send(
          LifecycleRequestResponseSchema.parse({
            version: 2,
            job: publicJob(await lifecycle.requestExport(principal)),
          }),
        );
      } catch (error) {
        return lifecycleError(reply, error);
      }
    },
  );

  app.get<{ Params: JobParams }>(
    '/v2/workspaces/:workspaceId/lifecycle/exports/:jobId/download',
    async (request, reply) => {
      try {
        const principal = await browserPrincipal(request, credentials);
        assertWorkspace(request.params.workspaceId, principal);
        const jobId = z.string().uuid().parse(request.params.jobId);
        const download = await lifecycle.openExport(principal, jobId);
        noStore(reply);
        reply.header('content-type', 'application/x-ndjson; charset=utf-8');
        reply.header('content-disposition', `attachment; filename="${download.filename}"`);
        reply.header('x-content-type-options', 'nosniff');
        return reply.send(download.body);
      } catch (error) {
        return lifecycleError(reply, error);
      }
    },
  );

  app.post<{ Params: WorkspaceParams }>(
    '/v2/workspaces/:workspaceId/lifecycle/deletion',
    async (request, reply) => {
      if (!trustedOrigin(request, allowedOrigins)) return forbidden(reply);
      try {
        const principal = await browserPrincipal(request, credentials);
        assertWorkspace(request.params.workspaceId, principal);
        const body = WorkspaceDeletionRequestSchema.parse(request.body);
        const job = await lifecycle.requestDeletion(principal, body.confirmation);
        noStore(reply);
        return reply.code(202).send(
          LifecycleRequestResponseSchema.parse({
            version: 2,
            job: publicJob(job),
          }),
        );
      } catch (error) {
        return lifecycleError(reply, error);
      }
    },
  );
}

async function browserPrincipal(
  request: FastifyRequest,
  credentials: OpaqueCredentialService,
): Promise<AuthenticatedPrincipal> {
  const structured = requestCredentials(request);
  if (structured.authorizationHeader) throw new CredentialAuthorizationError();
  const principal = await credentials.authenticate(structured);
  if (principal.credentialKind !== 'browser_session') throw new CredentialAuthorizationError();
  return principal;
}

function assertWorkspace(requested: string, principal: AuthenticatedPrincipal): void {
  if (parseWorkspaceId(requested) !== principal.workspaceId) {
    throw new LifecycleAuthorizationError();
  }
}

function publicJob(job: LifecycleJobView) {
  return { version: 2 as const, ...job };
}

function requestCredentials(request: FastifyRequest): WorkspaceCredentials {
  const authorizationHeader = header(request.headers.authorization);
  const cookieHeader = header(request.headers.cookie);
  return {
    ...(authorizationHeader ? { authorizationHeader } : {}),
    ...(cookieHeader ? { cookieHeader } : {}),
  };
}

function trustedOrigin(request: FastifyRequest, allowed: ReadonlySet<string>): boolean {
  const origin = header(request.headers.origin);
  return Boolean(origin && allowed.has(origin));
}

function forbidden(reply: FastifyReply) {
  return reply.code(403).send(apiError('csrf_rejected', 'Request origin is not allowed'));
}

function noStore(reply: FastifyReply): void {
  reply.header('cache-control', 'no-store');
  reply.header('pragma', 'no-cache');
}

function lifecycleError(reply: FastifyReply, error: unknown) {
  if (error instanceof ZodError || error instanceof LifecycleInputError) {
    return reply.code(400).send(apiError('invalid_request', 'Request is invalid'));
  }
  if (error instanceof CredentialAuthenticationError) {
    return reply.code(401).send(apiError('authentication_required', 'Authentication required'));
  }
  if (
    error instanceof CredentialAuthorizationError ||
    error instanceof LifecycleAuthorizationError
  ) {
    return reply.code(403).send(apiError('workspace_forbidden', 'Workspace access denied'));
  }
  if (error instanceof LifecycleJobNotFoundError) {
    return reply.code(404).send(apiError('lifecycle_job_not_found', 'Lifecycle job not found'));
  }
  if (error instanceof LifecycleExportNotReadyError) {
    return reply.code(409).send(apiError('export_not_ready', 'Export is not ready'));
  }
  return reply.code(500).send(apiError('lifecycle_unavailable', 'Lifecycle operation failed'));
}

function header(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : value?.[0];
}

function apiError(code: string, message: string) {
  return { error: { code, message } };
}
