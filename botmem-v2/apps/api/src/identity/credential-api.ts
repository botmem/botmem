import {
  PersonalAccessTokenIssueRequestSchema,
  PersonalAccessTokenIssueResponseSchema,
  PersonalAccessTokenListResponseSchema,
  parseWorkspaceId,
} from '@botmem-v2/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z, ZodError } from 'zod';
import type { WorkspaceCredentials } from '../search-api.js';
import {
  CredentialAuthenticationError,
  CredentialAuthorizationError,
  CredentialInputError,
  CredentialNotFoundError,
  OpaqueCredentialService,
} from './credential-service.js';
import type { AuthenticatedPrincipal } from './domain.js';

export interface CredentialApiOptions {
  readonly cookieName: string;
  readonly secureCookies: boolean;
}

interface WorkspaceParams {
  readonly workspaceId: string;
}

interface CredentialParams extends WorkspaceParams {
  readonly credentialId: string;
}

export function registerCredentialApi(
  app: FastifyInstance,
  credentials: OpaqueCredentialService,
  options: CredentialApiOptions,
): void {
  app.get<{ Params: WorkspaceParams }>(
    '/v2/workspaces/:workspaceId/pats',
    async (request, reply) => {
      try {
        const principal = await ownerBrowserPrincipal(request, credentials);
        assertWorkspace(request.params.workspaceId, principal);
        const items = await credentials.listPersonalAccessTokens(principal);
        noStore(reply);
        return reply.code(200).send(
          PersonalAccessTokenListResponseSchema.parse({
            version: 2,
            items: items.map((item) => ({ version: 2, ...item })),
          }),
        );
      } catch (error) {
        return identityError(reply, error);
      }
    },
  );

  app.post<{ Params: WorkspaceParams }>(
    '/v2/workspaces/:workspaceId/pats',
    async (request, reply) => {
      try {
        const principal = await ownerBrowserPrincipal(request, credentials);
        assertWorkspace(request.params.workspaceId, principal);
        const body = PersonalAccessTokenIssueRequestSchema.parse(request.body);
        const issued = await credentials.issuePersonalAccessToken(
          principal,
          body.label,
          body.ttlSeconds * 1_000,
          body.scopes,
        );
        noStore(reply);
        return reply.code(201).send(
          PersonalAccessTokenIssueResponseSchema.parse({
            version: 2,
            credentialId: issued.credentialId,
            accessToken: issued.value,
            expiresAt: issued.expiresAt,
          }),
        );
      } catch (error) {
        return identityError(reply, error);
      }
    },
  );

  app.delete<{ Params: CredentialParams }>(
    '/v2/workspaces/:workspaceId/pats/:credentialId',
    async (request, reply) => {
      try {
        const principal = await ownerBrowserPrincipal(request, credentials);
        assertWorkspace(request.params.workspaceId, principal);
        const credentialId = z.string().uuid().parse(request.params.credentialId);
        await credentials.revokePersonalAccessToken(principal, credentialId);
        noStore(reply);
        return reply.code(204).send();
      } catch (error) {
        return identityError(reply, error);
      }
    },
  );

  app.post('/v2/session/rotate', async (request, reply) => {
    try {
      const structured = structuredCredentials(request);
      if (structured.authorizationHeader) throw new CredentialAuthorizationError();
      const rotated = await credentials.rotate(structured);
      if (rotated.principal.credentialKind !== 'browser_session') {
        throw new CredentialAuthorizationError();
      }
      noStore(reply);
      reply.header(
        'set-cookie',
        sessionCookie(options, rotated.credential.value, rotated.credential.expiresAt),
      );
      return reply.code(204).send();
    } catch (error) {
      return identityError(reply, error);
    }
  });

  app.delete('/v2/session', async (request, reply) => {
    try {
      const structured = structuredCredentials(request);
      if (structured.authorizationHeader) throw new CredentialAuthorizationError();
      const revoked = await credentials.revoke(structured);
      noStore(reply);
      reply.header('set-cookie', clearSessionCookie(options));
      return reply
        .code(revoked ? 204 : 401)
        .send(revoked ? undefined : apiError('authentication_required', 'Authentication required'));
    } catch (error) {
      return identityError(reply, error);
    }
  });
}

async function ownerBrowserPrincipal(
  request: FastifyRequest,
  credentials: OpaqueCredentialService,
): Promise<AuthenticatedPrincipal> {
  const structured = structuredCredentials(request);
  // Bearer credentials never administer bearer credentials, even if a cookie
  // was accidentally attached by an intermediary.
  if (structured.authorizationHeader) throw new CredentialAuthorizationError();
  const principal = await credentials.authenticate(structured);
  if (principal.credentialKind !== 'browser_session') throw new CredentialAuthorizationError();
  return principal;
}

function assertWorkspace(requested: string, principal: AuthenticatedPrincipal): void {
  if (parseWorkspaceId(requested) !== principal.workspaceId) {
    throw new CredentialAuthorizationError();
  }
}

function structuredCredentials(request: FastifyRequest): WorkspaceCredentials {
  const authorization = singleHeader(request.headers.authorization);
  const cookie = singleHeader(request.headers.cookie);
  return {
    ...(authorization ? { authorizationHeader: authorization } : {}),
    ...(cookie ? { cookieHeader: cookie } : {}),
  };
}

function sessionCookie(options: CredentialApiOptions, value: string, expiresAt: string): string {
  return `${options.cookieName}=${value}; Path=/; Expires=${new Date(expiresAt).toUTCString()}; HttpOnly; SameSite=Strict${options.secureCookies ? '; Secure' : ''}`;
}

function clearSessionCookie(options: CredentialApiOptions): string {
  return `${options.cookieName}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict${options.secureCookies ? '; Secure' : ''}`;
}

function noStore(reply: FastifyReply): void {
  reply.header('cache-control', 'no-store');
  reply.header('pragma', 'no-cache');
}

function identityError(reply: FastifyReply, error: unknown) {
  if (error instanceof ZodError || error instanceof CredentialInputError) {
    return reply.code(400).send(apiError('invalid_request', 'Request is invalid'));
  }
  if (error instanceof CredentialAuthenticationError) {
    return reply.code(401).send(apiError('authentication_required', 'Authentication required'));
  }
  if (error instanceof CredentialAuthorizationError) {
    return reply.code(403).send(apiError('workspace_forbidden', 'Workspace access denied'));
  }
  if (error instanceof CredentialNotFoundError) {
    return reply.code(404).send(apiError('credential_not_found', 'Access token not found'));
  }
  return reply.code(500).send(apiError('identity_unavailable', 'Identity operation failed'));
}

function singleHeader(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : value?.[0];
}

function apiError(code: string, message: string) {
  return { error: { code, message } };
}
