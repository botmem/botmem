import { describe, expect, it } from 'vitest';
import { parseSearchRequest, SearchResponseSchema } from './search.js';

describe('SearchRequest contract', () => {
  it('parseSearchRequest_whenDefaultsOmitted_appliesCanonicalLimit', () => {
    const request = parseSearchRequest({ version: 2, query: '  launch notes  ' });

    expect(request).toEqual({
      version: 2,
      query: 'launch notes',
      limit: 20,
    });
  });

  it('parseSearchRequest_whenDateRangeIsReversed_rejectsRequest', () => {
    expect(() =>
      parseSearchRequest({
        version: 2,
        query: 'trip',
        from: '2026-07-14T00:00:00.000Z',
        to: '2026-07-13T00:00:00.000Z',
      }),
    ).toThrow(/from must be earlier/);
  });

  it('parseSearchRequest_whenUnknownFieldIsPresent_rejectsRequest', () => {
    expect(() =>
      parseSearchRequest({
        version: 2,
        query: 'trip',
        minimumScore: 0.5,
      }),
    ).toThrow();
  });

  it('parseSearchRequest_whenCursorIsProvided_rejectsHostedLocalContentState', () => {
    expect(() =>
      parseSearchRequest({
        version: 2,
        query: 'trip',
        cursor: 'opaque-page-state',
      }),
    ).toThrow();
  });

  it('parseSearchRequest_whenFiltersSelectNoPlacement_rejectsFalseSuccess', () => {
    expect(() =>
      parseSearchRequest({
        version: 2,
        query: 'trip',
        connectors: ['gmail'],
        deviceIds: ['df381211-58ea-4558-a36f-a2a3202bc682'],
      }),
    ).toThrow(/select no searchable lane/);
  });
});

describe('SearchResponse contract', () => {
  it('SearchResponseSchema_whenReadyResponseIsWellFormed_acceptsResponse', () => {
    const response = {
      version: 2,
      queryId: 'cfdf162d-fee7-4870-868d-091e9dc57561',
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
            tookMs: 4,
          },
        ],
      },
      found: 0,
      tookMs: 5,
    };

    expect(SearchResponseSchema.parse(response)).toEqual(response);
  });

  it('SearchResponseSchema_whenFailedLaneIsMarkedComplete_rejectsContradiction', () => {
    expect(() =>
      SearchResponseSchema.parse({
        version: 2,
        queryId: 'cfdf162d-fee7-4870-868d-091e9dc57561',
        items: [],
        coverage: {
          partial: false,
          lanes: [
            {
              laneId: 'hosted',
              placement: 'hosted',
              status: 'failed',
              retryable: true,
              returned: 0,
              tookMs: 4,
            },
          ],
        },
        found: 0,
        tookMs: 5,
      }),
    ).toThrow(/partial/);
  });

  it('SearchResponseSchema_whenDegradedLaneReturnedResults_acceptsHonestPartialCoverage', () => {
    const response = {
      version: 2,
      queryId: 'cfdf162d-fee7-4870-868d-091e9dc57561',
      items: [],
      coverage: {
        partial: true,
        lanes: [
          {
            laneId: 'hosted',
            placement: 'hosted',
            status: 'degraded',
            retryable: true,
            returned: 3,
            tookMs: 4,
            reasonCode: 'embedding_timeout',
          },
        ],
      },
      found: 0,
      tookMs: 5,
    };

    expect(SearchResponseSchema.parse(response)).toEqual(response);
  });

  it('SearchResponseSchema_whenOneDeviceConnectorIsBlocked_acceptsConnectorCoverage', () => {
    const response = {
      version: 2,
      queryId: 'cfdf162d-fee7-4870-868d-091e9dc57561',
      items: [],
      coverage: {
        partial: true,
        lanes: [
          {
            laneId: 'device:df381211-58ea-4558-a36f-a2a3202bc682:whatsapp',
            placement: 'device',
            deviceId: 'df381211-58ea-4558-a36f-a2a3202bc682',
            connector: 'whatsapp',
            status: 'permission_required',
            retryable: false,
            returned: 0,
            tookMs: 0,
            reasonCode: 'full_disk_access_required',
          },
        ],
      },
      found: 0,
      tookMs: 1,
    };

    expect(SearchResponseSchema.parse(response)).toEqual(response);
  });
});
