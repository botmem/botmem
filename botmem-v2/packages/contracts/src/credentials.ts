import { z } from 'zod';

export const PersonalAccessTokenScopeSchema = z.enum([
  'botmem:search',
  'botmem:connections:read',
  'botmem:devices:read',
]);
export type PersonalAccessTokenScope = z.infer<typeof PersonalAccessTokenScopeSchema>;

export const PersonalAccessTokenMetadataSchema = z
  .object({
    version: z.literal(2),
    credentialId: z.string().uuid(),
    label: z.string().min(1).max(128),
    tokenPrefix: z.string().min(8).max(24),
    scopes: z
      .array(PersonalAccessTokenScopeSchema)
      .min(1)
      .max(3)
      .refine(
        (scopes) => scopes.includes('botmem:search') && new Set(scopes).size === scopes.length,
      ),
    createdAt: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true }),
    lastUsedAt: z.string().datetime({ offset: true }).nullable(),
  })
  .strict();
export type PersonalAccessTokenMetadata = z.infer<typeof PersonalAccessTokenMetadataSchema>;

export const PersonalAccessTokenListResponseSchema = z
  .object({
    version: z.literal(2),
    items: z.array(PersonalAccessTokenMetadataSchema),
  })
  .strict();
export type PersonalAccessTokenListResponse = z.infer<typeof PersonalAccessTokenListResponseSchema>;

export const PersonalAccessTokenIssueRequestSchema = z
  .object({
    version: z.literal(2),
    label: z.string().trim().min(1).max(128),
    ttlSeconds: z
      .number()
      .int()
      .min(60)
      .max(366 * 86_400),
    scopes: z
      .array(PersonalAccessTokenScopeSchema)
      .min(1)
      .max(3)
      .refine(
        (scopes) => scopes.includes('botmem:search') && new Set(scopes).size === scopes.length,
      )
      .optional(),
  })
  .strict();
export type PersonalAccessTokenIssueRequest = z.infer<typeof PersonalAccessTokenIssueRequestSchema>;

export const PersonalAccessTokenIssueResponseSchema = z
  .object({
    version: z.literal(2),
    credentialId: z.string().uuid(),
    accessToken: z.string().regex(/^bmp_v2\.[A-Za-z0-9_-]{43}$/u),
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type PersonalAccessTokenIssueResponse = z.infer<
  typeof PersonalAccessTokenIssueResponseSchema
>;
