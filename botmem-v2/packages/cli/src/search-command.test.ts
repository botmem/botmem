import type { SearchRequestInput, SearchResponse } from '@botmem-v2/contracts';
import type { SearchApplicationService } from '@botmem-v2/sdk';
import { describe, expect, it } from 'vitest';
import { runSearchCommand } from './search-command.js';

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

describe('search CLI command', () => {
  it('runSearchCommand_whenCanonicalFiltersAreProvided_forwardsEveryFilter', async () => {
    let received: SearchRequestInput | undefined;
    const search: SearchApplicationService = {
      search: async (_workspaceId, input) => {
        received = input;
        return EMPTY_RESPONSE;
      },
    };

    await runSearchCommand(
      [
        'search',
        '--workspace',
        '8e5ffcc7-8e8f-4aaa-9c77-b87a979c60cf',
        '--query',
        'launch',
        '--connector',
        'gmail',
        '--connector',
        'imessage',
        '--kind',
        'email',
        '--kind',
        'message',
        '--from',
        '2026-07-01T00:00:00.000Z',
        '--to',
        '2026-07-13T00:00:00.000Z',
        '--participant-id',
        'person:durable',
        '--authored-by-me',
        'true',
        '--account-id',
        'ae9af62a-c77a-43f7-b4c3-b8b0dd2b76f7',
        '--device-id',
        'df381211-58ea-4558-a36f-a2a3202bc682',
        '--limit',
        '10',
        '--json',
      ],
      {
        search,
        io: { writeStdout: () => undefined },
      },
    );

    expect(received).toMatchObject({
      version: 2,
      query: 'launch',
      connectors: ['gmail', 'imessage'],
      kinds: ['email', 'message'],
      from: '2026-07-01T00:00:00.000Z',
      to: '2026-07-13T00:00:00.000Z',
      participantId: 'person:durable',
      authoredByMe: true,
      accountIds: ['ae9af62a-c77a-43f7-b4c3-b8b0dd2b76f7'],
      deviceIds: ['df381211-58ea-4558-a36f-a2a3202bc682'],
      limit: 10,
    });
  });

  it('runSearchCommand_whenUnknownFlagIsProvided_rejectsInsteadOfDiscardingIt', async () => {
    const search: SearchApplicationService = {
      search: async () => EMPTY_RESPONSE,
    };

    await expect(
      runSearchCommand(
        [
          'search',
          '--workspace',
          '8e5ffcc7-8e8f-4aaa-9c77-b87a979c60cf',
          '--query',
          'launch',
          '--minimum-score',
          '0.5',
        ],
        {
          search,
          io: { writeStdout: () => undefined },
        },
      ),
    ).rejects.toThrow(/unknown option/);
  });
});
