import { describe, expect, it, vi } from 'vitest';
import {
  OwnTracksEndpointPolicy,
  OwnTracksRecorderApi,
  SafeOwnTracksHttpClient,
  type OwnTracksClockPort,
  type PinnedHttpsTransportPort,
  type ValidatedOwnTracksEndpoint,
} from './index.js';

const endpoint: ValidatedOwnTracksEndpoint = Object.freeze({
  endpoint: 'https://tracks.example.test/api/0/locations?user=jane&device=phone',
  allowedPorts: [443],
});

function harness(responses: readonly { readonly status: number; readonly body: string }[]) {
  const transport: PinnedHttpsTransportPort = {
    get: vi.fn(),
  };
  responses.forEach((response) =>
    vi.mocked(transport.get).mockResolvedValueOnce({ ...response, headers: {} }),
  );
  const policy = new OwnTracksEndpointPolicy({
    resolveAll: vi.fn().mockResolvedValue([{ address: '1.1.1.1', family: 4 }]),
  });
  const sleep = vi.fn().mockResolvedValue(undefined);
  const clock: OwnTracksClockPort = {
    now: () => '2026-07-13T10:00:00.000Z',
    sleep,
  };
  const api = new OwnTracksRecorderApi(new SafeOwnTracksHttpClient(policy, transport), clock);
  return { api, transport, sleep };
}

describe('OwnTracksRecorderApi', () => {
  it('listLocations_onTransientStatuses_retriesWithBoundedBackoffThenReturnsEveryPoint', async () => {
    const { api, transport, sleep } = harness([
      { status: 503, body: '' },
      { status: 429, body: '' },
      {
        status: 200,
        body: JSON.stringify({
          count: 2,
          data: [
            { _type: 'location', tst: 1, lat: 1, lon: 2 },
            { _type: 'location', tst: 2, lat: 3, lon: 4 },
          ],
        }),
      },
    ]);

    const result = await api.listLocations(
      endpoint,
      { username: 'jane', password: 'vault-secret' },
      { fromEpochSeconds: 1, toEpochSeconds: 2 },
    );

    expect(result.points).toHaveLength(2);
    expect(transport.get).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map((call) => call[0])).toEqual([100, 200]);
    const request = vi.mocked(transport.get).mock.calls[0]?.[0];
    expect(request?.url.searchParams.get('user')).toBe('jane');
    expect(request?.url.searchParams.get('device')).toBe('phone');
    expect(request?.url.searchParams.get('format')).toBe('json');
    expect(request?.headers.authorization).toBe(
      `Basic ${Buffer.from('jane:vault-secret').toString('base64')}`,
    );
  });

  it.each([401, 403])(
    'listLocations_onAuthStatus_%s_failsWithoutRetryOrCredentialLeak',
    async (status) => {
      const { api, transport, sleep } = harness([{ status, body: 'provider detail with secret' }]);

      await expect(
        api.listLocations(
          endpoint,
          { username: 'jane', password: 'vault-secret' },
          { fromEpochSeconds: 1, toEpochSeconds: 2 },
        ),
      ).rejects.toMatchObject({
        failure: 'auth_failed',
        message: 'OwnTracks provider request failed: auth_failed',
      });
      expect(transport.get).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    },
  );

  it('listLocations_onExcessivelyNestedJson_rejectsAsInvalidWithoutReturningPartialData', async () => {
    let nested: unknown = { _type: 'location', tst: 1, lat: 1, lon: 2 };
    for (let index = 0; index < 40; index += 1) nested = { child: nested };
    const { api } = harness([{ status: 200, body: JSON.stringify({ data: [nested] }) }]);

    await expect(
      api.listLocations(
        endpoint,
        { username: 'jane', password: 'vault-secret' },
        { fromEpochSeconds: 1, toEpochSeconds: 2 },
      ),
    ).rejects.toMatchObject({ failure: 'invalid_response' });
  });
});
