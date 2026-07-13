import {
  BeginOAuthConnectionRequestSchema,
  ConnectionActionRequestSchema,
  ConnectionIdSchema,
  OwnTracksConnectionRequestSchema,
  parseWorkspaceId,
} from '@botmem-v2/contracts';
import type { ConnectionsApplicationService } from '@botmem-v2/sdk';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z, ZodError } from 'zod';
import {
  WorkspaceAuthorizationError,
  type WorkspaceAuthorizer,
  type WorkspaceCredentials,
} from '../search-api.js';
import {
  ConnectorCredentialError,
  HostedConnectionNotFoundError,
  HostedConnectionPersistenceError,
  HostedConnectionUnavailableError,
} from './ports.js';
import type { OAuthCallbackPort } from './service.js';

const callbackQuerySchema = z
  .object({
    state: z.string().min(16).max(4096),
    code: z.string().min(1).max(16_384).optional(),
    error: z.string().min(1).max(512).optional(),
  })
  .refine((query) => Boolean(query.code) !== Boolean(query.error), {
    message: 'OAuth callback requires exactly one of code or error',
  });

export interface HostedConnectionsApiDependencies {
  readonly connections: ConnectionsApplicationService;
  readonly oauthCallbacks: OAuthCallbackPort;
  readonly workspaceAuthorizer: WorkspaceAuthorizer;
  readonly readAuthorizer?: WorkspaceAuthorizer;
  readonly successRedirectUrl: string;
}

interface WorkspaceParams {
  readonly workspaceId: string;
}

interface ConnectionParams extends WorkspaceParams {
  readonly connectionId: string;
}

/** Registers the authenticated hosted-connection surface and exact OAuth callbacks. */
export function registerHostedConnectionsApi(
  app: FastifyInstance,
  dependencies: HostedConnectionsApiDependencies,
): void {
  const successRedirect = safeRedirect(dependencies.successRedirectUrl);

  app.get<{ Params: WorkspaceParams }>(
    '/v2/workspaces/:workspaceId/connections',
    async (request, reply) => {
      const workspaceId = await authorize(
        request,
        reply,
        dependencies.readAuthorizer ?? dependencies.workspaceAuthorizer,
      );
      if (!workspaceId) return;
      try {
        return reply.code(200).send(await dependencies.connections.listConnections(workspaceId));
      } catch (caught) {
        return operationalError(request, reply, caught);
      }
    },
  );

  app.post<{ Params: WorkspaceParams }>(
    '/v2/workspaces/:workspaceId/connections/oauth',
    async (request, reply) => {
      const workspaceId = await authorize(request, reply, dependencies.workspaceAuthorizer);
      if (!workspaceId) return;
      try {
        const body = BeginOAuthConnectionRequestSchema.parse(request.body);
        return reply
          .code(200)
          .send(await dependencies.connections.beginOAuthConnection(workspaceId, body));
      } catch (caught) {
        if (caught instanceof ZodError) {
          return reply
            .code(400)
            .send(envelope('invalid_connection_request', 'Invalid OAuth connection request'));
        }
        return operationalError(request, reply, caught);
      }
    },
  );

  app.post<{ Params: WorkspaceParams }>(
    '/v2/workspaces/:workspaceId/connections/owntracks',
    async (request, reply) => {
      const workspaceId = await authorize(request, reply, dependencies.workspaceAuthorizer);
      if (!workspaceId) return;
      try {
        const body = OwnTracksConnectionRequestSchema.parse(request.body);
        return reply
          .code(201)
          .send(await dependencies.connections.connectOwnTracks(workspaceId, body));
      } catch (caught) {
        if (caught instanceof ZodError) {
          return reply
            .code(400)
            .send(envelope('invalid_connection_request', 'Invalid OwnTracks connection request'));
        }
        return operationalError(request, reply, caught);
      }
    },
  );

  app.post<{ Params: ConnectionParams }>(
    '/v2/workspaces/:workspaceId/connections/:connectionId/actions',
    async (request, reply) => {
      const workspaceId = await authorize(request, reply, dependencies.workspaceAuthorizer);
      if (!workspaceId) return;
      try {
        const connectionId = ConnectionIdSchema.parse(request.params.connectionId);
        const body = ConnectionActionRequestSchema.parse(request.body);
        return reply
          .code(200)
          .send(await dependencies.connections.actOnConnection(workspaceId, connectionId, body));
      } catch (caught) {
        if (caught instanceof ZodError) {
          return reply
            .code(400)
            .send(envelope('invalid_connection_action', 'Invalid connection action'));
        }
        return operationalError(request, reply, caught);
      }
    },
  );

  registerCallback(app, 'gmail', dependencies.oauthCallbacks, successRedirect);
  registerCallback(app, 'outlook', dependencies.oauthCallbacks, successRedirect);
}

function registerCallback(
  app: FastifyInstance,
  connector: 'gmail' | 'outlook',
  callbacks: OAuthCallbackPort,
  successRedirect: URL,
): void {
  app.get(`/v2/connections/oauth/${connector}/callback`, async (request, reply) => {
    try {
      const query = callbackQuerySchema.parse(request.query);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000);
      try {
        const callback = {
          state: query.state,
          ...(query.code ? { code: query.code } : {}),
          ...(query.error ? { error: query.error } : {}),
          signal: controller.signal,
        };
        await (connector === 'gmail'
          ? callbacks.completeGmail(callback)
          : callbacks.completeOutlook(callback));
      } finally {
        clearTimeout(timeout);
      }
      const target = new URL(successRedirect);
      target.searchParams.set('connector', connector);
      target.searchParams.set('status', 'connected');
      return reply.redirect(target.toString(), 303);
    } catch (caught) {
      // Callback parameters and provider exceptions can contain secrets. Log
      // only a stable internal code and return a generic recovery response.
      if (
        caught instanceof ConnectorCredentialError ||
        caught instanceof HostedConnectionPersistenceError ||
        caught instanceof HostedConnectionUnavailableError
      ) {
        request.log.error(
          { code: 'oauth_callback_unavailable', connector },
          'OAuth callback unavailable',
        );
        return reply
          .code(503)
          .send(
            envelope(
              'connection_unavailable',
              'Connection service is unavailable. Retry from the connections page.',
            ),
          );
      }
      request.log.warn({ code: 'oauth_callback_failed', connector }, 'OAuth callback rejected');
      return reply
        .code(400)
        .send(
          envelope(
            'oauth_callback_failed',
            'Authorization could not be completed. Start a new connection attempt.',
          ),
        );
    }
  });
}

async function authorize(
  request: FastifyRequest<{ Params: WorkspaceParams }>,
  reply: FastifyReply,
  authorizer: WorkspaceAuthorizer,
): Promise<string | null> {
  try {
    const requested = parseWorkspaceId(request.params.workspaceId);
    const authorized = await authorizer.authorize(requested, credentials(request));
    if (requested !== authorized) {
      reply.code(403).send(envelope('workspace_forbidden', 'Workspace access denied'));
      return null;
    }
    return authorized;
  } catch (caught) {
    if (caught instanceof ZodError) {
      reply.code(400).send(envelope('invalid_workspace_id', 'Workspace ID must be a UUID'));
      return null;
    }
    if (caught instanceof WorkspaceAuthorizationError) {
      reply.code(caught.status).send(envelope(caught.code, caught.message));
      return null;
    }
    request.log.error({ code: 'authorization_failed' }, 'connection authorization failed');
    reply.code(500).send(envelope('authorization_failed', 'Authorization failed'));
    return null;
  }
}

function credentials(request: FastifyRequest): WorkspaceCredentials {
  const authorizationHeader = header(request.headers.authorization);
  const cookieHeader = header(request.headers.cookie);
  return {
    ...(authorizationHeader ? { authorizationHeader } : {}),
    ...(cookieHeader ? { cookieHeader } : {}),
  };
}

function header(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : value?.[0];
}

function operationalError(request: FastifyRequest, reply: FastifyReply, caught: unknown) {
  if (caught instanceof HostedConnectionNotFoundError) {
    return reply.code(404).send(envelope('connection_not_found', 'Connection not found'));
  }
  if (caught instanceof HostedConnectionUnavailableError) {
    return reply.code(409).send(envelope('connection_unavailable', 'Connection is unavailable'));
  }
  if (
    caught instanceof ConnectorCredentialError ||
    caught instanceof HostedConnectionPersistenceError
  ) {
    request.log.error({ code: 'connection_persistence_failed' }, 'connection persistence failed');
    return reply
      .code(503)
      .send(envelope('connection_unavailable', 'Connection service is unavailable'));
  }
  request.log.error({ code: 'connection_operation_failed' }, 'connection operation failed');
  return reply
    .code(503)
    .send(envelope('connection_unavailable', 'Connection service is unavailable'));
}

function safeRedirect(value: string): URL {
  const url = new URL(value);
  if (
    (url.protocol !== 'https:' && url.hostname !== 'localhost') ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new Error('OAuth success redirect must be credential-free HTTPS');
  }
  return url;
}

function envelope(code: string, message: string) {
  return { error: { code, message } };
}
