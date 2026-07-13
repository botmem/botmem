import { z } from 'zod';

const ReleaseVersionSchema = z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+(?:[-.][A-Za-z0-9.-]+)?$/u);
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const UnavailableArtifactSchema = z.object({ available: z.literal(false) }).strict();

function availableArtifact(extension: '.dmg' | '.tgz') {
  return z
    .object({
      available: z.literal(true),
      url: z.string().url().max(4_096),
      releaseVersion: ReleaseVersionSchema,
      sha256: Sha256Schema,
    })
    .strict()
    .superRefine((value, context) => {
      const url = new URL(value.url);
      const tagSegments = url.pathname.split('/').filter(Boolean);
      const versioned = tagSegments.some(
        (segment) =>
          segment === value.releaseVersion ||
          segment === `v${value.releaseVersion}` ||
          segment.endsWith(`-v${value.releaseVersion}`),
      );
      if (
        url.protocol !== 'https:' ||
        url.username.length > 0 ||
        url.password.length > 0 ||
        url.search.length > 0 ||
        url.hash.length > 0 ||
        !url.pathname.toLowerCase().endsWith(extension) ||
        !versioned
      ) {
        context.addIssue({
          code: 'custom',
          path: ['url'],
          message: `release URL must be immutable HTTPS and end in ${extension}`,
        });
      }
    });
}

export const MacReleaseArtifactSchema = z.union([
  UnavailableArtifactSchema,
  availableArtifact('.dmg'),
]);

export const CliReleaseArtifactSchema = z.union([
  UnavailableArtifactSchema,
  availableArtifact('.tgz'),
]);

export const PublicReleaseConfigurationSchema = z
  .object({
    version: z.literal(2),
    apiBaseUrl: z
      .string()
      .url()
      .max(2_048)
      .superRefine((value, context) => {
        const url = new URL(value);
        if (
          (url.protocol !== 'https:' && url.protocol !== 'http:') ||
          url.username.length > 0 ||
          url.password.length > 0 ||
          url.pathname !== '/' ||
          url.search.length > 0 ||
          url.hash.length > 0
        ) {
          context.addIssue({
            code: 'custom',
            message: 'apiBaseUrl must be a credential-free origin',
          });
        }
      }),
    macos: MacReleaseArtifactSchema,
    cli: CliReleaseArtifactSchema,
  })
  .strict();

export type MacReleaseArtifact = z.infer<typeof MacReleaseArtifactSchema>;
export type CliReleaseArtifact = z.infer<typeof CliReleaseArtifactSchema>;
export type PublicReleaseConfiguration = z.infer<typeof PublicReleaseConfigurationSchema>;
