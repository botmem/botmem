import { describe, expect, it, vi } from 'vitest';
import {
  isPublicInternetAddress,
  OwnTracksEndpointPolicy,
  OwnTracksEndpointRejectedError,
  OwnTracksProviderError,
  OwnTracksRedirectError,
  OwnTracksTransportError,
  SafeOwnTracksHttpClient,
  type OwnTracksDnsPort,
  type PinnedHttpsTransportPort,
  type ResolvedAddress,
} from './index.js';

const PUBLIC_V4: ResolvedAddress = Object.freeze({ address: '1.1.1.1', family: 4 });
const PUBLIC_V6: ResolvedAddress = Object.freeze({
  address: '2606:4700:4700::1111',
  family: 6,
});

function dns(...answers: readonly (readonly ResolvedAddress[])[]): OwnTracksDnsPort {
  const resolveAll = vi.fn();
  answers.forEach((answer) => resolveAll.mockResolvedValueOnce(answer));
  return { resolveAll };
}

describe('OwnTracksEndpointPolicy', () => {
  it.each([
    '0.0.0.0',
    '10.0.0.1',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '192.0.0.9',
    '192.0.2.1',
    '192.31.196.1',
    '192.52.193.1',
    '192.168.1.1',
    '192.175.48.1',
    '198.18.0.1',
    '198.51.100.1',
    '203.0.113.1',
    '224.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    '::ffff:127.0.0.1',
    '64:ff9b::1',
    '100::1',
    '2001:db8::1',
    '2002::1',
    '2620:4f:8000::1',
    '3fff::1',
    '5f00::1',
    'fc00::1',
    'fe80::1',
    'ff02::1',
  ])('isPublicInternetAddress_rejectsSpecialAddress_%s', (address) => {
    expect(isPublicInternetAddress(address)).toBe(false);
  });

  it.each(['1.1.1.1', '8.8.8.8', '93.184.216.34', '2606:4700:4700::1111'])(
    'isPublicInternetAddress_acceptsPublicAddress_%s',
    (address) => expect(isPublicInternetAddress(address)).toBe(true),
  );

  it('configure_resolvesEveryAddressAndAcceptsOnlyPublicHttpsOnAllowedPort', async () => {
    const resolver = dns([PUBLIC_V4, PUBLIC_V6]);
    const policy = new OwnTracksEndpointPolicy(resolver);

    const configured = await policy.configure({
      endpoint: 'https://tracks.example.test:8443/api/0/locations?user=a&device=b',
      allowedPorts: [8443],
    });

    expect(configured).toEqual({
      endpoint: 'https://tracks.example.test:8443/api/0/locations?user=a&device=b',
      allowedPorts: [8443],
    });
    expect(resolver.resolveAll).toHaveBeenCalledWith('tracks.example.test', undefined);
  });

  it.each([
    'http://tracks.example.test/api/0/locations',
    'https://user:secret@tracks.example.test/api/0/locations',
    'https://tracks.example.test/api/0/locations#fragment',
    'https://tracks.example.test:8443/api/0/locations',
    'https://tracks.example.test/api/0/kill',
    'https://tracks.example.test/api/0/%6cocations',
    'https://%31%32%37.0.0.1/api/0/locations',
    'https://2130706433/api/0/locations',
    'https://[::ffff:127.0.0.1]/api/0/locations',
  ])('configure_rejectsUnsafeOrEncodedEndpoint_%s', async (endpoint) => {
    const policy = new OwnTracksEndpointPolicy(dns([PUBLIC_V4]));
    await expect(policy.configure({ endpoint })).rejects.toBeInstanceOf(
      OwnTracksEndpointRejectedError,
    );
  });

  it('configure_rejectsEntireDnsAnswerSetWhenAnyAddressIsPrivate', async () => {
    const policy = new OwnTracksEndpointPolicy(
      dns([PUBLIC_V4, { address: '10.0.0.7', family: 4 }]),
    );
    await expect(
      policy.configure({ endpoint: 'https://tracks.example.test/api/0/locations' }),
    ).rejects.toBeInstanceOf(OwnTracksEndpointRejectedError);
  });

  it('configure_allowsPrivateEndpointsOnlyThroughTheExplicitTestPolicy', async () => {
    const privateAddress = Object.freeze({ address: '127.0.0.1', family: 4 as const });
    const endpoint = 'https://localhost:9443/api/0/locations';
    const productionPolicy = new OwnTracksEndpointPolicy(dns([privateAddress]), {
      defaultAllowedPorts: [9443],
    });
    const testPolicy = new OwnTracksEndpointPolicy(dns([privateAddress]), {
      allowPrivateTestEndpoints: true,
      defaultAllowedPorts: [9443],
    });

    await expect(productionPolicy.configure({ endpoint })).rejects.toBeInstanceOf(
      OwnTracksEndpointRejectedError,
    );
    await expect(testPolicy.configure({ endpoint })).resolves.toEqual({
      endpoint,
      allowedPorts: [9443],
    });
  });

  it('configure_rejectsDnsAnswerFanoutBeyondBound', async () => {
    const answers = Array.from({ length: 17 }, (_, index) => ({
      address: `8.8.8.${index + 1}`,
      family: 4 as const,
    }));
    const policy = new OwnTracksEndpointPolicy(dns(answers));
    await expect(
      policy.configure({ endpoint: 'https://tracks.example.test/api/0/locations' }),
    ).rejects.toBeInstanceOf(OwnTracksEndpointRejectedError);
  });

  it('get_reResolvesForEveryRequestAndBlocksDnsRebindingBeforeSecondConnection', async () => {
    const resolver = dns([PUBLIC_V4], [{ address: '127.0.0.1', family: 4 }]);
    const policy = new OwnTracksEndpointPolicy(resolver);
    const endpoint = await policy.configure({
      endpoint: 'https://tracks.example.test/api/0/locations',
    });
    const transport: PinnedHttpsTransportPort = {
      get: vi.fn().mockResolvedValue({ status: 200, headers: {}, body: '{"data":[]}' }),
    };
    const client = new SafeOwnTracksHttpClient(policy, transport);

    await expect(
      client.get({
        endpoint,
        url: new URL(endpoint.endpoint),
        credentials: { username: 'owner', password: 'vault-secret' },
        timeoutMs: 1000,
        maxResponseBytes: 1024,
      }),
    ).rejects.toBeInstanceOf(OwnTracksEndpointRejectedError);
    expect(transport.get).not.toHaveBeenCalled();
  });

  it('get_revalidatesRedirectAndRejectsPrivateOrCrossOriginDestination', async () => {
    const resolver = dns([PUBLIC_V4], [PUBLIC_V4]);
    const policy = new OwnTracksEndpointPolicy(resolver);
    const endpoint = await policy.configure({
      endpoint: 'https://tracks.example.test/api/0/locations',
    });
    const transport: PinnedHttpsTransportPort = {
      get: vi.fn().mockResolvedValue({
        status: 302,
        headers: { location: 'https://127.0.0.1/admin' },
        body: '',
      }),
    };
    const client = new SafeOwnTracksHttpClient(policy, transport);

    await expect(
      client.get({
        endpoint,
        url: new URL(endpoint.endpoint),
        credentials: { username: 'owner', password: 'vault-secret' },
        timeoutMs: 1000,
        maxResponseBytes: 1024,
      }),
    ).rejects.toBeInstanceOf(OwnTracksRedirectError);
    expect(transport.get).toHaveBeenCalledTimes(1);
  });

  it('get_onSameOriginRedirect_reResolvesAndBlocksAChangedPrivateDnsAnswer', async () => {
    const resolver = dns([PUBLIC_V4], [PUBLIC_V4], [{ address: '10.0.0.8', family: 4 }]);
    const policy = new OwnTracksEndpointPolicy(resolver);
    const endpoint = await policy.configure({
      endpoint: 'https://tracks.example.test/api/0/locations',
    });
    const transport: PinnedHttpsTransportPort = {
      get: vi.fn().mockResolvedValue({
        status: 302,
        headers: { location: '/api/0/locations?page=2' },
        body: '',
      }),
    };
    const client = new SafeOwnTracksHttpClient(policy, transport);

    await expect(
      client.get({
        endpoint,
        url: new URL(endpoint.endpoint),
        credentials: { username: 'owner', password: 'vault-secret' },
        timeoutMs: 1000,
        maxResponseBytes: 1024,
      }),
    ).rejects.toBeInstanceOf(OwnTracksEndpointRejectedError);
    expect(transport.get).toHaveBeenCalledTimes(1);
    expect(resolver.resolveAll).toHaveBeenCalledTimes(3);
  });

  it('get_whenBodyExceedsBound_returnsSanitizedProviderFailure', async () => {
    const resolver = dns([PUBLIC_V4], [PUBLIC_V4]);
    const policy = new OwnTracksEndpointPolicy(resolver);
    const endpoint = await policy.configure({
      endpoint: 'https://tracks.example.test/api/0/locations',
    });
    const transport: PinnedHttpsTransportPort = {
      get: vi.fn().mockRejectedValue(new OwnTracksTransportError('response_too_large')),
    };
    const client = new SafeOwnTracksHttpClient(policy, transport);

    await expect(
      client.get({
        endpoint,
        url: new URL(endpoint.endpoint),
        credentials: { username: 'owner', password: 'vault-secret' },
        timeoutMs: 1000,
        maxResponseBytes: 10,
      }),
    ).rejects.toMatchObject<Partial<OwnTracksProviderError>>({
      failure: 'response_too_large',
      message: 'OwnTracks provider request failed: response_too_large',
    });
  });
});
