import type { SearchRequestInput, SearchResponse } from '@botmem-v2/contracts';
import type { SearchApplicationService } from '@botmem-v2/sdk';
import { describe, expect, it } from 'vitest';
import { createMcpSearchTool } from './search-tool.js';

const EMPTY_RESPONSE: SearchResponse = {
  version: 2,
  queryId: '52b2ecba-3d9a-4c9d-89c8-e06c7916eec1',
  items: [],
  coverage: {
    partial: false,
    lanes: [
      {
        laneId: 'hosted',
        placement: 'hosted',
        status: 'complete',
        retryable: false,
        returned: 0,
        tookMs: 1,
      },
    ],
  },
  found: 0,
  tookMs: 1,
};

describe('MCP search tool', () => {
  it('invoke_whenCanonicalFiltersAreProvided_forwardsEveryFilter', async () => {
    let received: SearchRequestInput | undefined;
    const search: SearchApplicationService = {
      search: async (_workspaceId, input) => {
        received = input;
        return EMPTY_RESPONSE;
      },
    };

    await createMcpSearchTool(search, '8e5ffcc7-8e8f-4aaa-9c77-b87a979c60cf').invoke({
      query: 'launch',
      connectors: ['gmail', 'imessage'],
      kinds: ['email', 'message'],
      participantId: 'person:durable',
      authoredByMe: false,
      accountIds: ['ae9af62a-c77a-43f7-b4c3-b8b0dd2b76f7'],
      deviceIds: ['df381211-58ea-4558-a36f-a2a3202bc682'],
    });

    expect(received).toMatchObject({
      version: 2,
      query: 'launch',
      connectors: ['gmail', 'imessage'],
      kinds: ['email', 'message'],
      participantId: 'person:durable',
      authoredByMe: false,
      accountIds: ['ae9af62a-c77a-43f7-b4c3-b8b0dd2b76f7'],
      deviceIds: ['df381211-58ea-4558-a36f-a2a3202bc682'],
      limit: 20,
    });
  });

  it('createMcpSearchTool_exposesTheCanonicalGeneratedInputSchema', () => {
    const search: SearchApplicationService = {
      search: async () => EMPTY_RESPONSE,
    };
    const schema = createMcpSearchTool(search, '8e5ffcc7-8e8f-4aaa-9c77-b87a979c60cf').inputSchema;
    const properties = schema['properties'] as Record<string, unknown>;

    expect(Object.keys(properties)).toEqual(
      expect.arrayContaining([
        'query',
        'connectors',
        'kinds',
        'participantId',
        'authoredByMe',
        'accountIds',
        'deviceIds',
      ]),
    );
    expect(schema['additionalProperties']).toBe(false);
  });
});
