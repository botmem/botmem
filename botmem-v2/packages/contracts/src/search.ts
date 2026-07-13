import { z } from 'zod';

export const ConnectorSchema = z.enum(['gmail', 'outlook', 'owntracks', 'imessage', 'whatsapp']);
export type Connector = z.infer<typeof ConnectorSchema>;

export const MemoryKindSchema = z.enum(['email', 'message', 'location']);
export type MemoryKind = z.infer<typeof MemoryKindSchema>;

export const DurableIdentifierSchema = z
  .object({
    kind: z.enum(['email', 'phone', 'provider_user_id', 'connector_account_id']),
    value: z.string().trim().min(1).max(512),
  })
  .strict();
export type DurableIdentifier = z.infer<typeof DurableIdentifierSchema>;

export const ParticipantSchema = z
  .object({
    durableId: z.string().trim().min(1).max(512),
    displayName: z.string().trim().min(1).max(512).optional(),
    role: z.enum(['author', 'sender', 'recipient', 'participant', 'mentioned']).optional(),
    identifiers: z.array(DurableIdentifierSchema).max(16).default([]),
  })
  .strict();
export type Participant = z.infer<typeof ParticipantSchema>;

const HostedOriginSchema = z
  .object({
    placement: z.literal('hosted'),
    connector: z.enum(['gmail', 'outlook', 'owntracks']),
    accountId: z.string().uuid(),
  })
  .strict();

const DeviceOriginSchema = z
  .object({
    placement: z.literal('device'),
    connector: z.enum(['imessage', 'whatsapp']),
    deviceId: z.string().uuid(),
  })
  .strict();

export const SearchOriginSchema = z.discriminatedUnion('placement', [
  HostedOriginSchema,
  DeviceOriginSchema,
]);
export type SearchOrigin = z.infer<typeof SearchOriginSchema>;

export const ThreadSchema = z
  .object({
    durableId: z.string().trim().min(1).max(1024),
    title: z.string().trim().min(1).max(1024).optional(),
  })
  .strict();
export type Thread = z.infer<typeof ThreadSchema>;

export const MediaDescriptorSchema = z
  .object({
    durableId: z.string().trim().min(1).max(1024),
    mimeType: z.string().trim().min(1).max(255),
    fileName: z.string().trim().min(1).max(1024).optional(),
    sizeBytes: z.number().int().nonnegative().optional(),
    availability: z.enum(['hosted', 'device_online', 'device_offline', 'unavailable']),
  })
  .strict();
export type MediaDescriptor = z.infer<typeof MediaDescriptorSchema>;

const SearchRequestFields = {
  query: z.string().trim().min(1).max(512),
  connectors: z.array(ConnectorSchema).min(1).max(5).optional(),
  kinds: z.array(MemoryKindSchema).min(1).max(3).optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  participantId: z.string().trim().min(1).max(512).optional(),
  authoredByMe: z.boolean().optional(),
  accountIds: z.array(z.string().uuid()).min(1).max(32).optional(),
  deviceIds: z.array(z.string().uuid()).min(1).max(16).optional(),
  limit: z.number().int().min(1).max(100).default(20),
} as const;

export const SearchRequestSchema = z
  .object({
    version: z.literal(2),
    ...SearchRequestFields,
  })
  .strict()
  .superRefine((request, context) => {
    if (request.from && request.to && Date.parse(request.from) > Date.parse(request.to)) {
      context.addIssue({
        code: 'custom',
        path: ['from'],
        message: 'from must be earlier than or equal to to',
      });
    }

    const connectors = request.connectors ?? ConnectorSchema.options;
    const kinds = request.kinds ?? MemoryKindSchema.options;
    const allowsHostedConnector = connectors.some(
      (connector) => connector === 'gmail' || connector === 'outlook' || connector === 'owntracks',
    );
    const allowsDeviceConnector = connectors.some(
      (connector) => connector === 'imessage' || connector === 'whatsapp',
    );
    const allowsHostedKind = kinds.some((kind) => kind === 'email' || kind === 'location');
    const allowsDeviceKind = kinds.includes('message');
    const placementScoped = Boolean(request.accountIds || request.deviceIds);
    const hasHostedLane =
      allowsHostedConnector &&
      allowsHostedKind &&
      (!placementScoped || Boolean(request.accountIds));
    const hasDeviceLane =
      allowsDeviceConnector && allowsDeviceKind && (!placementScoped || Boolean(request.deviceIds));
    if (!hasHostedLane && !hasDeviceLane) {
      context.addIssue({
        code: 'custom',
        path: ['connectors'],
        message: 'connector, kind, account, and device filters select no searchable lane',
      });
    }
  });
export type SearchRequest = z.infer<typeof SearchRequestSchema>;
export type SearchRequestInput = z.input<typeof SearchRequestSchema>;

export const SearchToolInputSchema = z.object(SearchRequestFields).strict();
export type SearchToolInput = z.input<typeof SearchToolInputSchema>;
export const SEARCH_TOOL_INPUT_JSON_SCHEMA = z.toJSONSchema(SearchToolInputSchema, {
  target: 'draft-7',
});

const SearchCandidateFields = {
  ref: z.string().trim().min(1).max(2048),
  sourceId: z.string().trim().min(1).max(2048),
  revision: z.string().trim().min(1).max(512),
  origin: SearchOriginSchema,
  kind: MemoryKindSchema,
  occurredAt: z.iso.datetime({ offset: true }).nullable(),
  title: z.string().trim().min(1).max(2048).optional(),
  text: z.string().max(20_000),
  thread: ThreadSchema.optional(),
  participants: z.array(ParticipantSchema).max(256),
  media: z.array(MediaDescriptorSchema).max(128),
  authoredByMe: z.boolean().optional(),
  citation: z.string().trim().min(1).max(4096),
} as const;

export const SearchCandidateSchema = z
  .object(SearchCandidateFields)
  .strict()
  .superRefine((candidate, context) => {
    const expectedKind =
      candidate.origin.connector === 'owntracks'
        ? 'location'
        : candidate.origin.connector === 'gmail' || candidate.origin.connector === 'outlook'
          ? 'email'
          : 'message';
    if (candidate.kind !== expectedKind) {
      context.addIssue({
        code: 'custom',
        path: ['kind'],
        message: `${candidate.origin.connector} results must have kind ${expectedKind}`,
      });
    }
  });
export type SearchCandidate = z.infer<typeof SearchCandidateSchema>;

export const SearchHitSchema = z
  .object({
    ...SearchCandidateFields,
    ranking: z
      .object({
        rank: z.number().int().positive(),
        score: z.number().min(0).max(1),
        matchedLanes: z.array(z.string().trim().min(1).max(256)).min(1).max(32),
      })
      .strict(),
  })
  .strict()
  .superRefine((hit, context) => {
    const expectedKind =
      hit.origin.connector === 'owntracks'
        ? 'location'
        : hit.origin.connector === 'gmail' || hit.origin.connector === 'outlook'
          ? 'email'
          : 'message';
    if (hit.kind !== expectedKind) {
      context.addIssue({
        code: 'custom',
        path: ['kind'],
        message: `${hit.origin.connector} results must have kind ${expectedKind}`,
      });
    }
  });
export type SearchHit = z.infer<typeof SearchHitSchema>;

export const SearchLaneStatusSchema = z.enum([
  'complete',
  'degraded',
  'offline',
  'permission_required',
  'indexing',
  'timed_out',
  'failed',
]);
export type SearchLaneStatus = z.infer<typeof SearchLaneStatusSchema>;

export const SearchLaneCoverageSchema = z
  .object({
    laneId: z.string().trim().min(1).max(256),
    placement: z.enum(['hosted', 'device']),
    deviceId: z.string().uuid().optional(),
    connector: ConnectorSchema.optional(),
    status: SearchLaneStatusSchema,
    retryable: z.boolean(),
    returned: z.number().int().nonnegative(),
    tookMs: z.number().int().nonnegative(),
    reasonCode: z.string().trim().min(1).max(128).optional(),
  })
  .strict()
  .superRefine((lane, context) => {
    if (lane.placement === 'hosted' && lane.deviceId) {
      context.addIssue({
        code: 'custom',
        path: ['deviceId'],
        message: 'a hosted lane cannot identify a device',
      });
    }
    if (
      lane.connector &&
      (lane.placement !== 'device' ||
        (lane.connector !== 'imessage' && lane.connector !== 'whatsapp'))
    ) {
      context.addIssue({
        code: 'custom',
        path: ['connector'],
        message: 'connector-level coverage is limited to local device connectors',
      });
    }
  });
export type SearchLaneCoverage = z.infer<typeof SearchLaneCoverageSchema>;

export const SearchResponseSchema = z
  .object({
    version: z.literal(2),
    queryId: z.string().uuid(),
    items: z.array(SearchHitSchema),
    coverage: z
      .object({
        partial: z.boolean(),
        lanes: z.array(SearchLaneCoverageSchema),
      })
      .strict(),
    found: z.number().int().nonnegative(),
    tookMs: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((response, context) => {
    const expectedPartial = response.coverage.lanes.some((lane) => lane.status !== 'complete');
    if (response.coverage.partial !== expectedPartial) {
      context.addIssue({
        code: 'custom',
        path: ['coverage', 'partial'],
        message: 'partial must be true exactly when a requested lane is incomplete',
      });
    }
    if (response.found < response.items.length) {
      context.addIssue({
        code: 'custom',
        path: ['found'],
        message: 'found cannot be smaller than the returned item count',
      });
    }
    const refs = new Set<string>();
    response.items.forEach((item, index) => {
      if (refs.has(item.ref)) {
        context.addIssue({
          code: 'custom',
          path: ['items', index, 'ref'],
          message: 'response item references must be unique',
        });
      }
      refs.add(item.ref);
      if (item.ranking.rank !== index + 1) {
        context.addIssue({
          code: 'custom',
          path: ['items', index, 'ranking', 'rank'],
          message: 'ranking.rank must match the response order',
        });
      }
    });
    response.coverage.lanes.forEach((lane, index) => {
      if (lane.status !== 'complete' && lane.status !== 'degraded' && lane.returned !== 0) {
        context.addIssue({
          code: 'custom',
          path: ['coverage', 'lanes', index, 'returned'],
          message: 'an unavailable lane cannot report returned results',
        });
      }
      if (lane.status === 'complete' && lane.retryable) {
        context.addIssue({
          code: 'custom',
          path: ['coverage', 'lanes', index, 'retryable'],
          message: 'a complete lane cannot be retryable',
        });
      }
    });
  });
export type SearchResponse = z.infer<typeof SearchResponseSchema>;

export function parseSearchRequest(input: unknown): SearchRequest {
  return SearchRequestSchema.parse(input);
}

export function parseSearchResponse(input: unknown): SearchResponse {
  return SearchResponseSchema.parse(input);
}
