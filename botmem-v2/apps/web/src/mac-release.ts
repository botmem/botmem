import type { PublicReleaseConfiguration } from '@botmem-v2/contracts';

export function unavailableReleaseConfiguration(apiBaseUrl: string): PublicReleaseConfiguration {
  return {
    version: 2,
    apiBaseUrl: new URL(apiBaseUrl).origin + '/',
    macos: { available: false },
    cli: { available: false },
  };
}
