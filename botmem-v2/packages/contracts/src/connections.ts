import { z } from 'zod';
import { SourceStatusSchema } from './sources.js';

export const HostedConnectorSchema = z.enum(['gmail', 'outlook', 'owntracks']);
export type HostedConnector = z.infer<typeof HostedConnectorSchema>;
export const ConnectionIdSchema = z.string().uuid();

export const HostedConnectionSchema = z
  .object({
    id: ConnectionIdSchema,
    connector: HostedConnectorSchema,
    authType: z.enum(['oauth2', 'basic']),
    label: z.string().trim().min(1).max(320),
    state: z.enum(['authorizing', 'syncing', 'ready', 'degraded', 'revoked', 'disconnected']),
    source: SourceStatusSchema,
    lastSyncAt: z.iso.datetime({ offset: true }).optional(),
    failureCode: z.string().trim().min(1).max(128).optional(),
  })
  .strict()
  .superRefine((connection, context) => {
    const expectedAuth = connection.connector === 'owntracks' ? 'basic' : 'oauth2';
    if (connection.authType !== expectedAuth) {
      context.addIssue({
        code: 'custom',
        path: ['authType'],
        message: `${connection.connector} requires ${expectedAuth} authentication`,
      });
    }
    if (connection.source.connector !== connection.connector) {
      context.addIssue({
        code: 'custom',
        path: ['source', 'connector'],
        message: 'connection and source connectors must match',
      });
    }
  });
export type HostedConnection = z.infer<typeof HostedConnectionSchema>;

export const ConnectionListResponseSchema = z
  .object({
    version: z.literal(2),
    items: z.array(HostedConnectionSchema).max(32),
  })
  .strict();
export type ConnectionListResponse = z.infer<typeof ConnectionListResponseSchema>;
export const ConnectionListToolInputSchema = z.object({}).strict();

export const BeginOAuthConnectionRequestSchema = z
  .object({
    version: z.literal(2),
    connector: z.enum(['gmail', 'outlook']),
  })
  .strict();
export type BeginOAuthConnectionRequest = z.infer<typeof BeginOAuthConnectionRequestSchema>;

export const BeginOAuthConnectionResponseSchema = z
  .object({
    version: z.literal(2),
    connector: z.enum(['gmail', 'outlook']),
    accountId: ConnectionIdSchema,
    authorizationUrl: z.url().refine((value) => {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password && !url.hash;
    }, 'authorization URL must be credential-free HTTPS without a fragment'),
    expiresAt: z.iso.datetime({ offset: true }),
  })
  .strict();
export type BeginOAuthConnectionResponse = z.infer<typeof BeginOAuthConnectionResponseSchema>;

export const OwnTracksConnectionRequestSchema = z
  .object({
    version: z.literal(2),
    endpoint: z
      .url()
      .refine((value) => new URL(value).protocol === 'https:', 'OwnTracks endpoint must use HTTPS'),
    username: z.string().min(1).max(320),
    password: z.string().min(1).max(4096),
  })
  .strict();
export type OwnTracksConnectionRequest = z.infer<typeof OwnTracksConnectionRequestSchema>;

export const ConnectionMutationResponseSchema = z
  .object({
    version: z.literal(2),
    connection: HostedConnectionSchema,
  })
  .strict();
export type ConnectionMutationResponse = z.infer<typeof ConnectionMutationResponseSchema>;

export const ConnectionActionRequestSchema = z
  .object({
    version: z.literal(2),
    action: z.enum(['sync', 'disconnect']),
  })
  .strict();
export type ConnectionActionRequest = z.infer<typeof ConnectionActionRequestSchema>;
