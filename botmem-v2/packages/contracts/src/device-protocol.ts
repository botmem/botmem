import { z } from 'zod';
import { MediaDescriptorSchema, ParticipantSchema, ThreadSchema } from './search.js';
import { SourceStatusSchema } from './sources.js';

export const DEVICE_PROTOCOL = 'botmem.device.v2' as const;
export const MAX_DEVICE_FRAME_BYTES = 1_048_576;

const LocalConnectorSchema = z.enum(['imessage', 'whatsapp']);

export const DeviceSearchQuerySchema = z
  .object({
    query: z.string().trim().min(1).max(512),
    connectors: z.array(LocalConnectorSchema).min(1).max(2).optional(),
    kinds: z.array(z.literal('message')).min(1).max(1).optional(),
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
    participantId: z.string().trim().min(1).max(512).optional(),
    authoredByMe: z.boolean().optional(),
    limit: z.number().int().min(1).max(100),
    cursor: z.string().min(1).max(4096).nullable(),
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
  });
export type DeviceSearchQuery = z.infer<typeof DeviceSearchQuerySchema>;

export const DeviceSearchItemSchema = z
  .object({
    ref: z.string().trim().min(1).max(2048),
    sourceId: z.string().trim().min(1).max(2048),
    revision: z.string().trim().min(1).max(512),
    connector: LocalConnectorSchema,
    occurredAt: z.iso.datetime({ offset: true }).nullable(),
    title: z.string().trim().min(1).max(2048).optional(),
    text: z.string().max(20_000),
    thread: ThreadSchema.optional(),
    participants: z.array(ParticipantSchema).max(256),
    media: z.array(MediaDescriptorSchema).max(128),
    authoredByMe: z.boolean().optional(),
  })
  .strict();
export type DeviceSearchItem = z.infer<typeof DeviceSearchItemSchema>;

const EnvelopeSchema = z
  .object({
    protocol: z.literal(DEVICE_PROTOCOL),
    requestId: z.string().uuid(),
    sentAt: z.iso.datetime({ offset: true }),
    deadlineAt: z.iso.datetime({ offset: true }),
  })
  .strict();

const HelloSchema = EnvelopeSchema.extend({
  type: z.literal('hello'),
  payload: z
    .object({
      deviceId: z.string().uuid(),
      clientVersion: z.string().trim().min(1).max(64),
      nonce: z.string().min(16).max(512),
    })
    .strict(),
}).strict();

const ChallengeSchema = EnvelopeSchema.extend({
  type: z.literal('challenge'),
  payload: z
    .object({
      nonce: z.string().min(16).max(512),
      serverNonce: z.string().min(16).max(512),
    })
    .strict(),
}).strict();

const AuthenticateSchema = EnvelopeSchema.extend({
  type: z.literal('authenticate'),
  payload: z
    .object({
      deviceId: z.string().uuid(),
      keyId: z.string().trim().min(1).max(128),
      signature: z.string().min(32).max(1024),
    })
    .strict(),
}).strict();

const AuthenticatedSchema = EnvelopeSchema.extend({
  type: z.literal('authenticated'),
  payload: z
    .object({
      sessionId: z.string().uuid(),
      heartbeatIntervalMs: z.number().int().min(5_000).max(120_000),
      credentialExpiresAt: z.iso.datetime({ offset: true }),
    })
    .strict(),
}).strict();

const CapabilitiesSchema = EnvelopeSchema.extend({
  type: z.literal('capabilities'),
  payload: z
    .object({
      connectors: z.array(LocalConnectorSchema).max(2),
      rpc: z
        .array(z.enum(['source.status', 'search.query', 'search.cancel']))
        .min(1)
        .max(3),
      maximumResultCount: z.number().int().min(1).max(100),
    })
    .strict(),
}).strict();

const SourceStatusReportSchema = EnvelopeSchema.extend({
  type: z.literal('source.status'),
  payload: z
    .object({
      sources: z
        .array(
          SourceStatusSchema.refine(
            (source) => source.connector === 'imessage' || source.connector === 'whatsapp',
            'device status may only report device-local connectors',
          ),
        )
        .max(2),
    })
    .strict(),
}).strict();

const HeartbeatSchema = EnvelopeSchema.extend({
  type: z.literal('heartbeat'),
  payload: z
    .object({
      sessionId: z.string().uuid(),
      sequence: z.number().int().nonnegative(),
    })
    .strict(),
}).strict();

const SearchRequestFrameSchema = EnvelopeSchema.extend({
  type: z.literal('search.request'),
  payload: z
    .object({
      queryId: z.string().uuid(),
      query: DeviceSearchQuerySchema,
    })
    .strict(),
}).strict();

const SearchResponseFrameSchema = EnvelopeSchema.extend({
  type: z.literal('search.response'),
  payload: z
    .object({
      queryId: z.string().uuid(),
      items: z.array(DeviceSearchItemSchema).max(100),
      found: z.number().int().nonnegative(),
      nextCursor: z.string().min(1).max(4096).nullable(),
      tookMs: z.number().int().nonnegative(),
    })
    .strict(),
}).strict();

const SearchCancelFrameSchema = EnvelopeSchema.extend({
  type: z.literal('search.cancel'),
  payload: z
    .object({
      queryId: z.string().uuid(),
      reasonCode: z.enum(['caller_cancelled', 'deadline_exceeded', 'session_closing']),
    })
    .strict(),
}).strict();

const ErrorFrameSchema = EnvelopeSchema.extend({
  type: z.literal('error'),
  payload: z
    .object({
      code: z.string().trim().min(1).max(128),
      retryable: z.boolean(),
    })
    .strict(),
}).strict();

const RevokeFrameSchema = EnvelopeSchema.extend({
  type: z.literal('revoke'),
  payload: z
    .object({
      reasonCode: z.enum(['user_revoked', 'credential_rotated', 'device_deleted']),
    })
    .strict(),
}).strict();

export const DeviceFrameSchema = z.discriminatedUnion('type', [
  HelloSchema,
  ChallengeSchema,
  AuthenticateSchema,
  AuthenticatedSchema,
  CapabilitiesSchema,
  SourceStatusReportSchema,
  HeartbeatSchema,
  SearchRequestFrameSchema,
  SearchResponseFrameSchema,
  SearchCancelFrameSchema,
  ErrorFrameSchema,
  RevokeFrameSchema,
]);
export type DeviceFrame = z.infer<typeof DeviceFrameSchema>;

export function parseDeviceFrame(input: string | Uint8Array): DeviceFrame {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  if (bytes.byteLength > MAX_DEVICE_FRAME_BYTES) {
    throw new RangeError('device frame exceeds maximum payload size');
  }

  const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  const frame = DeviceFrameSchema.parse(parsed);
  if (Date.parse(frame.deadlineAt) <= Date.parse(frame.sentAt)) {
    throw new RangeError('device frame deadline must be later than sentAt');
  }
  return frame;
}
