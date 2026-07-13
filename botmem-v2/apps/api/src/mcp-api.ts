import { parseWorkspaceId } from '@botmem-v2/contracts';
import { createBotmemMcpServer } from '@botmem-v2/mcp';
import type {
  ConnectionsApplicationService,
  DevicesApplicationService,
  SearchApplicationService,
} from '@botmem-v2/sdk';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { WorkspaceAuthorizationError, type WorkspaceAuthorizer } from './search-api.js';

const MCP_SCOPE = 'botmem:search';
const MCP_BODY_LIMIT = 1_048_576;

export interface McpApiDependencies {
  readonly search: SearchApplicationService;
  readonly connections?: ConnectionsApplicationService;
  readonly devices?: DevicesApplicationService;
  readonly workspaceAuthorizer: WorkspaceAuthorizer;
  readonly connectionReadAuthorizer?: WorkspaceAuthorizer;
  readonly deviceReadAuthorizer?: WorkspaceAuthorizer;
  /** Public HTTPS origin, for example https://api.botmem.com. */
  readonly publicBaseUrl: string;
  readonly allowedOrigins?: readonly string[];
}

interface WorkspaceParams {
  workspaceId: string;
}

/** Registers the authenticated, stateless Streamable HTTP MCP surface. */
export function registerMcpApi(app: FastifyInstance, dependencies: McpApiDependencies): void {
  const publicBase = validateOriginUrl(dependencies.publicBaseUrl, 'publicBaseUrl');
  const allowedOrigins = new Set([
    publicBase.origin,
    ...(dependencies.allowedOrigins ?? []).map(
      (origin) => validateOriginUrl(origin, 'allowedOrigin').origin,
    ),
  ]);

  app.route<{ Params: WorkspaceParams }>({
    method: ['GET', 'POST', 'DELETE'],
    url: '/v2/workspaces/:workspaceId/mcp',
    bodyLimit: MCP_BODY_LIMIT,
    handler: async (request, reply) => {
      let workspaceId: string;
      try {
        workspaceId = parseWorkspaceId(request.params.workspaceId);
      } catch (caught) {
        if (caught instanceof ZodError) {
          return reply.code(404).send(jsonRpcError(-32000, 'Not found'));
        }
        throw caught;
      }

      if (!requestHostMatches(request, publicBase.hostname)) {
        return reply.code(403).send(jsonRpcError(-32000, 'Forbidden'));
      }
      const origin = headerValue(request.headers.origin);
      if (origin && !allowedOrigins.has(origin)) {
        return reply.code(403).send(jsonRpcError(-32000, 'Forbidden'));
      }

      const authorizationHeader = headerValue(request.headers.authorization);
      try {
        if (!authorizationHeader?.startsWith('Bearer ')) {
          throw new WorkspaceAuthorizationError(
            401,
            'authentication_required',
            'Bearer authentication required',
          );
        }
        const authorizedWorkspace = await dependencies.workspaceAuthorizer.authorize(workspaceId, {
          authorizationHeader,
        });
        if (authorizedWorkspace !== workspaceId) {
          throw new WorkspaceAuthorizationError(403, 'workspace_forbidden', 'Workspace denied');
        }
      } catch (caught) {
        if (caught instanceof WorkspaceAuthorizationError) {
          if (caught.status === 401) {
            reply.header('www-authenticate', `Bearer scope="${MCP_SCOPE}"`);
          }
          return reply.code(caught.status).send(jsonRpcError(-32001, 'Unauthorized'));
        }
        request.log.error({ code: 'mcp_authorization_failed' }, 'MCP authorization failed');
        return reply.code(500).send(jsonRpcError(-32603, 'Internal error'));
      }

      if (request.method !== 'POST') {
        reply.header('allow', 'POST');
        return reply.code(405).send(jsonRpcError(-32000, 'Method not allowed'));
      }

      const structured = { authorizationHeader };
      const [canReadConnections, canReadDevices] = await Promise.all([
        optionalScopeAuthorized(dependencies.connectionReadAuthorizer, workspaceId, structured),
        optionalScopeAuthorized(dependencies.deviceReadAuthorizer, workspaceId, structured),
      ]);

      await handleMcpPost(
        request,
        reply,
        dependencies.search,
        canReadConnections ? dependencies.connections : undefined,
        canReadDevices ? dependencies.devices : undefined,
        workspaceId,
      );
    },
  });
}

async function optionalScopeAuthorized(
  authorizer: WorkspaceAuthorizer | undefined,
  workspaceId: string,
  credentials: { readonly authorizationHeader: string },
): Promise<boolean> {
  if (!authorizer) return false;
  try {
    return (await authorizer.authorize(workspaceId, credentials)) === workspaceId;
  } catch (error) {
    if (error instanceof WorkspaceAuthorizationError) return false;
    throw error;
  }
}

async function handleMcpPost(
  request: FastifyRequest,
  reply: FastifyReply,
  search: SearchApplicationService,
  connections: ConnectionsApplicationService | undefined,
  devices: DevicesApplicationService | undefined,
  workspaceId: string,
): Promise<void> {
  const server = createBotmemMcpServer(search, workspaceId, connections, devices);
  const transport = new StreamableHTTPServerTransport({
    enableJsonResponse: true,
  });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await Promise.allSettled([transport.close(), server.close()]);
  };
  reply.raw.once('close', () => void close());
  reply.hijack();
  try {
    await server.connect(transport as unknown as Parameters<typeof server.connect>[0]);
    await transport.handleRequest(request.raw, reply.raw, request.body);
  } catch {
    request.log.error({ code: 'mcp_request_failed' }, 'MCP request failed');
    if (!reply.raw.headersSent) {
      reply.raw.statusCode = 500;
      reply.raw.setHeader('content-type', 'application/json');
      reply.raw.end(JSON.stringify(jsonRpcError(-32603, 'Internal error')));
    } else if (!reply.raw.writableEnded) {
      reply.raw.end();
    }
  } finally {
    if (reply.raw.writableEnded) await close();
  }
}

function requestHostMatches(request: FastifyRequest, expectedHostname: string): boolean {
  const host = headerValue(request.headers.host);
  if (!host) return false;
  try {
    return new URL(`http://${host}`).hostname === expectedHostname;
  } catch {
    return false;
  }
}

function validateOriginUrl(value: string, name: string): URL {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    url.pathname !== '/' ||
    (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1')
  ) {
    throw new Error(
      `${name} must be an HTTPS origin without credentials, path, query, or fragment`,
    );
  }
  return url;
}

function headerValue(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : value?.[0];
}

function jsonRpcError(code: number, message: string) {
  return { jsonrpc: '2.0' as const, error: { code, message }, id: null };
}
