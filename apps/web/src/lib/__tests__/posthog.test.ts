import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const init = vi.fn();

vi.mock('posthog-js', () => ({
  default: { init },
}));

describe('posthog', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn());
    vi.stubEnv('VITE_POSTHOG_API_KEY', 'ph_test');
    vi.stubEnv('VITE_POSTHOG_HOST', 'https://t.botmem.test');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('initializes without probing /decide', async () => {
    const { initPostHog } = await import('../posthog');

    await initPostHog();

    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(init).toHaveBeenCalledWith(
      'ph_test',
      expect.objectContaining({
        api_host: 'https://t.botmem.test',
        advanced_disable_feature_flags: true,
        advanced_disable_feature_flags_on_first_load: true,
      }),
    );
  });
});
