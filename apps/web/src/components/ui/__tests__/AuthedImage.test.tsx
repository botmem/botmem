import { render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthedImage } from '../AuthedImage';

vi.mock('../../../store/authStore', () => ({
  useAuthStore: {
    getState: () => ({ accessToken: 'token-1' }),
  },
}));

function deferredResponse() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function okResponse(): Response {
  return {
    ok: true,
    status: 200,
    blob: () => Promise.resolve(new Blob(['img'], { type: 'image/png' })),
  } as Response;
}

describe('AuthedImage', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:avatar');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('limits concurrent avatar fetches', async () => {
    const deferred = Array.from({ length: 5 }, deferredResponse);
    let next = 0;
    vi.mocked(fetch).mockImplementation(() => deferred[next++].promise);

    render(
      <>
        {Array.from({ length: 5 }, (_, i) => (
          <AuthedImage key={i} src={`/api/people/${i}/avatar`} fallback={null} />
        ))}
      </>,
    );

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(4));
    deferred[0].resolve(okResponse());
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(5));
    for (const pending of deferred.slice(1)) pending.resolve(okResponse());
    await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalledTimes(5));
  });

  it('retries avatar fetches once after a 503', async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(fetch)
        .mockResolvedValueOnce({ ok: false, status: 503 } as Response)
        .mockResolvedValueOnce(okResponse());

      render(<AuthedImage src="/api/people/p1/avatar" fallback={null} />);

      expect(fetch).toHaveBeenCalledTimes(1);
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(250);
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
