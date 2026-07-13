import { describe, expect, it } from 'vitest';
import { AccountApiClient, type HttpRequest, type HttpTransport } from './http.js';

const WORKSPACE_ID = '8e5ffcc7-8e8f-4aaa-9c77-b87a979c60cf';
const CREDENTIAL_ID = '52b2ecba-3d9a-4c9d-89c8-e06c7916eec1';

describe('AccountApiClient', () => {
  it('uses ambient browser requests for PAT and lifecycle owner operations', async () => {
    const requests: HttpRequest[] = [];
    const transport: HttpTransport = {
      request: async (request) => {
        requests.push(request);
        if (request.path.endsWith('/pats') && request.method === 'GET') {
          return { status: 200, body: { version: 2, items: [] } };
        }
        if (request.path.endsWith('/pats') && request.method === 'POST') {
          return {
            status: 201,
            body: {
              version: 2,
              credentialId: CREDENTIAL_ID,
              accessToken: `bmp_v2.${'A'.repeat(43)}`,
              expiresAt: '2026-08-12T12:00:00.000Z',
            },
          };
        }
        if (request.path.endsWith('/lifecycle/jobs')) {
          return { status: 200, body: { version: 2, items: [] } };
        }
        if (request.path.endsWith('/lifecycle/exports')) {
          return { status: 202, body: lifecycleResponse('export') };
        }
        if (request.path.endsWith('/lifecycle/deletion')) {
          return { status: 202, body: lifecycleResponse('deletion') };
        }
        return { status: 204, body: null };
      },
    };
    const client = new AccountApiClient(transport);

    await client.listPersonalAccessTokens(WORKSPACE_ID);
    await client.issuePersonalAccessToken(WORKSPACE_ID, {
      version: 2,
      label: 'Codex MCP',
      ttlSeconds: 2_592_000,
    });
    await client.revokePersonalAccessToken(WORKSPACE_ID, CREDENTIAL_ID);
    await client.listLifecycleJobs(WORKSPACE_ID);
    await client.requestWorkspaceExport(WORKSPACE_ID);
    await client.requestWorkspaceDeletion(WORKSPACE_ID, `DELETE ${WORKSPACE_ID}`);
    await client.signOut();

    expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
      `GET /v2/workspaces/${WORKSPACE_ID}/pats`,
      `POST /v2/workspaces/${WORKSPACE_ID}/pats`,
      `DELETE /v2/workspaces/${WORKSPACE_ID}/pats/${CREDENTIAL_ID}`,
      `GET /v2/workspaces/${WORKSPACE_ID}/lifecycle/jobs`,
      `POST /v2/workspaces/${WORKSPACE_ID}/lifecycle/exports`,
      `POST /v2/workspaces/${WORKSPACE_ID}/lifecycle/deletion`,
      'DELETE /v2/session',
    ]);
    expect(requests.every((request) => request.headers['authorization'] === undefined)).toBe(true);
  });
});

function lifecycleResponse(kind: 'export' | 'deletion') {
  return {
    version: 2,
    job: {
      version: 2,
      jobId:
        kind === 'export'
          ? '54ba7eb0-7d2d-418c-841f-84d22958c95e'
          : '880a97f8-d069-4031-a26a-aa56baeb465e',
      kind,
      state: 'queued',
      requestedAt: '2026-07-13T12:00:00.000Z',
      attempts: 0,
      availableUntil: null,
      completedAt: null,
      failureCode: null,
      localDelete: kind === 'deletion' ? { delivered: 0, unreachable: 0, pending: 0 } : null,
    },
  };
}
