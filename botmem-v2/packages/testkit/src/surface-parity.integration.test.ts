import { WorkspaceAuthorizationError, buildSearchApi } from '@botmem-v2/api';
import { runSearchCommand } from '@botmem-v2/cli';
import { SourceStatusSchema, parseSearchResponse } from '@botmem-v2/contracts';
import { createMcpSearchTool } from '@botmem-v2/mcp';
import {
  SearchApiClient,
  type HttpRequest,
  type HttpResponse,
  type HttpTransport,
} from '@botmem-v2/sdk';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SENTINEL_ACCESS_TOKEN,
  SENTINEL_QUERY,
  SENTINEL_WORKSPACE_ID,
  createSentinelFixture,
} from './sentinel-fixture.js';

const openApis: Array<ReturnType<typeof buildSearchApi>> = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(openApis.splice(0).map((app) => app.close()));
});

describe('Botmem v2 search surface parity', () => {
  it('search_whenAllSourcesAreReady_returnsIdenticalIdsAndProvenanceAcrossSdkCliAndMcp', async () => {
    const fixture = createSentinelFixture();
    expect(fixture.statuses.map((status) => SourceStatusSchema.parse(status).readiness)).toEqual([
      'ready',
      'ready',
      'ready',
    ]);
    const sdk = createHttpSdk(fixture.service);
    const input = { version: 2 as const, query: SENTINEL_QUERY };

    const httpResponse = await sdk.search(SENTINEL_WORKSPACE_ID, input);

    let cliOutput = '';
    await runSearchCommand(
      ['search', '--workspace', SENTINEL_WORKSPACE_ID, '--query', SENTINEL_QUERY, '--json'],
      {
        search: sdk,
        io: {
          writeStdout: (value) => {
            cliOutput += value;
          },
        },
      },
    );
    const cliResponse = parseSearchResponse(JSON.parse(cliOutput));

    const mcpResponse = (
      await createMcpSearchTool(sdk, SENTINEL_WORKSPACE_ID).invoke({ query: SENTINEL_QUERY })
    ).structuredContent;

    const expected = ['imessage:sentinel', 'gmail:sentinel', 'whatsapp:sentinel'];
    expect(httpResponse.items.map((item) => item.ref)).toEqual(expected);
    expect(cliResponse).toEqual(httpResponse);
    expect(mcpResponse).toEqual(httpResponse);
    expect(httpResponse.coverage.partial).toBe(false);
    expect(httpResponse.coverage.lanes.map((lane) => lane.status)).toEqual([
      'complete',
      'complete',
    ]);
  });

  it('search_whenDeviceIsOffline_preservesHostedResultAndPartialCoverageAcrossSurfaces', async () => {
    const fixture = createSentinelFixture('offline');
    const sdk = createHttpSdk(fixture.service);
    const httpResponse = await sdk.search(SENTINEL_WORKSPACE_ID, {
      version: 2,
      query: SENTINEL_QUERY,
    });

    let cliOutput = '';
    await runSearchCommand(
      ['search', '--workspace', SENTINEL_WORKSPACE_ID, '--query', SENTINEL_QUERY, '--json'],
      {
        search: sdk,
        io: {
          writeStdout: (value) => {
            cliOutput += value;
          },
        },
      },
    );
    const cliResponse = parseSearchResponse(JSON.parse(cliOutput));
    const mcpResponse = (
      await createMcpSearchTool(sdk, SENTINEL_WORKSPACE_ID).invoke({ query: SENTINEL_QUERY })
    ).structuredContent;

    expect(httpResponse.items.map((item) => item.ref)).toEqual(['gmail:sentinel']);
    expect(httpResponse.coverage.partial).toBe(true);
    expect(httpResponse.coverage.lanes).toContainEqual({
      laneId: 'device:df381211-58ea-4558-a36f-a2a3202bc682',
      placement: 'device',
      deviceId: 'df381211-58ea-4558-a36f-a2a3202bc682',
      status: 'offline',
      retryable: true,
      returned: 0,
      tookMs: 0,
      reasonCode: 'device_disconnected',
    });
    expect(cliResponse).toEqual(httpResponse);
    expect(mcpResponse).toEqual(httpResponse);
  });

  it('search_whenTokenIsMissing_rejectsBeforeCallingSearch', async () => {
    const fixture = createSentinelFixture();
    const sdk = createHttpSdk(fixture.service, '');

    await expect(
      sdk.search(SENTINEL_WORKSPACE_ID, { version: 2, query: SENTINEL_QUERY }),
    ).rejects.toMatchObject({
      status: 401,
      code: 'authentication_required',
    });
  });

  it('search_whenTokenTargetsAnotherWorkspace_rejectsCrossWorkspaceAccess', async () => {
    const fixture = createSentinelFixture();
    const sdk = createHttpSdk(fixture.service);

    await expect(
      sdk.search('64080c7f-a574-4934-82c1-fdd7da8ab16c', {
        version: 2,
        query: SENTINEL_QUERY,
      }),
    ).rejects.toMatchObject({
      status: 403,
      code: 'workspace_forbidden',
    });
  });

  it('search_whenPublishedCliBinaryRuns_returnsTheCanonicalHttpResponse', async () => {
    const fixture = createSentinelFixture();
    const app = authorizedApi(fixture.service);
    openApis.push(app);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('expected TCP test listener');
    const cliPath = fileURLToPath(new URL('../../cli/dist/bin.js', import.meta.url));

    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [
        cliPath,
        'search',
        '--workspace',
        SENTINEL_WORKSPACE_ID,
        '--query',
        SENTINEL_QUERY,
        '--json',
      ],
      {
        env: {
          ...process.env,
          BOTMEM_API_URL: `http://127.0.0.1:${address.port}`,
          BOTMEM_ACCESS_TOKEN: SENTINEL_ACCESS_TOKEN,
        },
      },
    );

    expect(stderr).toBe('');
    const response = parseSearchResponse(JSON.parse(stdout));
    expect(response.items.map((item) => item.ref)).toEqual([
      'imessage:sentinel',
      'gmail:sentinel',
      'whatsapp:sentinel',
    ]);
  });
});

function createHttpSdk(
  service: Parameters<typeof buildSearchApi>[0]['search'],
  accessToken = SENTINEL_ACCESS_TOKEN,
): SearchApiClient {
  const app = authorizedApi(service);
  openApis.push(app);

  const transport: HttpTransport = {
    request: async (request: HttpRequest): Promise<HttpResponse> => {
      const response = await app.inject({
        method: request.method,
        url: request.path,
        headers: request.headers,
        payload: request.body,
      });
      return { status: response.statusCode, body: response.json() };
    },
  };
  return new SearchApiClient({
    transport,
    authentication: { kind: 'bearer', accessToken: accessToken || 'missing-token' },
  });
}

function authorizedApi(
  service: Parameters<typeof buildSearchApi>[0]['search'],
): ReturnType<typeof buildSearchApi> {
  return buildSearchApi({
    search: service,
    workspaceAuthorizer: {
      authorize: async (workspaceId, credentials) => {
        if (credentials.authorizationHeader !== `Bearer ${SENTINEL_ACCESS_TOKEN}`) {
          throw new WorkspaceAuthorizationError(
            401,
            'authentication_required',
            'Authentication required',
          );
        }
        if (workspaceId !== SENTINEL_WORKSPACE_ID) {
          throw new WorkspaceAuthorizationError(
            403,
            'workspace_forbidden',
            'Workspace access denied',
          );
        }
        return workspaceId;
      },
    },
  });
}
