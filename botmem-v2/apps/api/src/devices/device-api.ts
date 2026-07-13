import { parseWorkspaceId } from '@botmem-v2/contracts';
import type { DevicesApplicationService } from '@botmem-v2/sdk';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z, ZodError } from 'zod';
import {
  WorkspaceAuthorizationError,
  type WorkspaceAuthorizer,
  type WorkspaceCredentials,
} from '../search-api.js';
import {
  DeviceChallengeRejectedError,
  DeviceNotFoundError,
  DeviceSignatureRejectedError,
  type DeviceAuthenticationService,
} from './authentication-service.js';
import { DeviceOwnershipError, DeviceRevokedError } from './domain.js';
import {
  DeviceRateLimitedError,
  PairingCodeRejectedError,
  type DevicePairingService,
} from './pairing-service.js';
import type { DeviceSessionRevocationPort } from './session-revocation.js';

const pairSchema = z
  .object({
    code: z.string().min(20).max(256),
    deviceId: z.string().uuid(),
    displayName: z.string().trim().min(1).max(128),
    keyId: z.string().trim().min(1).max(128),
    publicKeyBase64Url: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
    connectors: z
      .array(z.enum(['imessage', 'whatsapp']))
      .min(1)
      .max(2),
  })
  .strict();

interface WorkspaceParams {
  readonly workspaceId: string;
}

interface DeviceParams extends WorkspaceParams {
  readonly deviceId: string;
}

export interface DeviceApiDependencies {
  readonly devices: DevicesApplicationService;
  readonly pairing: DevicePairingService;
  readonly authentication: DeviceAuthenticationService;
  readonly workspaceAuthorizer: WorkspaceAuthorizer;
  readonly readAuthorizer?: WorkspaceAuthorizer;
  readonly sessionRevoker?: DeviceSessionRevocationPort;
}

/** Authenticated device management surface; request bodies are never logged. */
export function registerDeviceApi(app: FastifyInstance, dependencies: DeviceApiDependencies): void {
  app.get<{ Params: WorkspaceParams }>(
    '/v2/workspaces/:workspaceId/devices',
    async (request, reply) => {
      const workspaceId = await authorizeWorkspace(
        request,
        reply,
        dependencies.readAuthorizer ?? dependencies.workspaceAuthorizer,
      );
      if (!workspaceId) return;
      try {
        return reply.code(200).send(await dependencies.devices.listDevices(workspaceId));
      } catch {
        request.log.error({ code: 'device_list_failed' }, 'device list failed');
        return reply.code(500).send(apiError('device_list_failed', 'Device list failed'));
      }
    },
  );

  app.post<{ Params: WorkspaceParams }>(
    '/v2/workspaces/:workspaceId/devices/pairing-codes',
    async (request, reply) => {
      const workspaceId = await authorizeWorkspace(
        request,
        reply,
        dependencies.workspaceAuthorizer,
      );
      if (!workspaceId) return;
      try {
        const result = await dependencies.pairing.issue(owner(workspaceId));
        reply.header('cache-control', 'no-store');
        return reply.code(201).send(result);
      } catch (error) {
        if (error instanceof DeviceRateLimitedError) {
          return reply.code(429).send(apiError('rate_limited', 'Too many pairing attempts'));
        }
        request.log.error({ code: 'pairing_issue_failed' }, 'pairing code issue failed');
        return reply.code(500).send(apiError('pairing_issue_failed', 'Pairing failed'));
      }
    },
  );

  app.post<{ Params: WorkspaceParams }>(
    '/v2/workspaces/:workspaceId/devices/pair',
    async (request, reply) => {
      try {
        const workspaceId = parseWorkspaceId(request.params.workspaceId);
        const input = pairSchema.parse(request.body);
        const result = await dependencies.pairing.complete({
          ...owner(workspaceId),
          ...input,
        });
        reply.header('cache-control', 'no-store');
        return reply.code(201).send({ deviceId: result.deviceId, state: 'paired' });
      } catch (error) {
        if (error instanceof ZodError) {
          return reply
            .code(400)
            .send(apiError('invalid_pairing_request', 'Invalid pairing request'));
        }
        if (error instanceof PairingCodeRejectedError) {
          return reply.code(401).send(apiError('pairing_rejected', 'Pairing code rejected'));
        }
        if (error instanceof DeviceRateLimitedError) {
          return reply.code(429).send(apiError('rate_limited', 'Too many pairing attempts'));
        }
        request.log.error({ code: 'pairing_failed' }, 'device pairing failed');
        return reply.code(500).send(apiError('pairing_failed', 'Pairing failed'));
      }
    },
  );

  app.delete<{ Params: DeviceParams }>(
    '/v2/workspaces/:workspaceId/devices/:deviceId',
    async (request, reply) => {
      const workspaceId = await authorizeWorkspace(
        request,
        reply,
        dependencies.workspaceAuthorizer,
      );
      if (!workspaceId) return;
      const parsedDeviceId = z.string().uuid().safeParse(request.params.deviceId);
      if (!parsedDeviceId.success) {
        return reply.code(400).send(apiError('invalid_device_id', 'Device ID must be a UUID'));
      }
      try {
        await dependencies.authentication.revoke({
          ...owner(workspaceId),
          deviceId: parsedDeviceId.data,
          reason: 'user_revoked',
        });
        await dependencies.sessionRevoker
          ?.revoke(workspaceId, parsedDeviceId.data, 'user_revoked')
          .catch(() => undefined);
        return reply.code(204).send();
      } catch (error) {
        if (error instanceof DeviceNotFoundError) {
          return reply.code(404).send(apiError('device_not_found', 'Device not found'));
        }
        if (error instanceof DeviceOwnershipError) {
          return reply.code(403).send(apiError('workspace_forbidden', 'Workspace access denied'));
        }
        if (
          error instanceof DeviceRevokedError ||
          error instanceof DeviceChallengeRejectedError ||
          error instanceof DeviceSignatureRejectedError
        ) {
          return reply.code(409).send(apiError('device_not_active', 'Device is not active'));
        }
        request.log.error({ code: 'device_revoke_failed' }, 'device revoke failed');
        return reply.code(500).send(apiError('device_revoke_failed', 'Device revoke failed'));
      }
    },
  );
}

async function authorizeWorkspace(
  request: FastifyRequest<{ Params: WorkspaceParams }>,
  reply: FastifyReply,
  authorizer: WorkspaceAuthorizer,
): Promise<string | undefined> {
  try {
    const requested = parseWorkspaceId(request.params.workspaceId);
    const authorized = await authorizer.authorize(requested, credentials(request));
    if (authorized !== requested) {
      reply.code(403).send(apiError('workspace_forbidden', 'Workspace access denied'));
      return undefined;
    }
    return authorized;
  } catch (error) {
    if (error instanceof ZodError) {
      reply.code(400).send(apiError('invalid_workspace_id', 'Workspace ID must be a UUID'));
      return undefined;
    }
    if (error instanceof WorkspaceAuthorizationError) {
      reply.code(error.status).send(apiError(error.code, error.message));
      return undefined;
    }
    request.log.error({ code: 'authorization_failed' }, 'device authorization failed');
    reply.code(500).send(apiError('authorization_failed', 'Authorization failed'));
    return undefined;
  }
}

function owner(workspaceId: string): { tenantId: string; workspaceId: string } {
  return { tenantId: workspaceId, workspaceId };
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

function apiError(code: string, message: string) {
  return { error: { code, message } };
}
