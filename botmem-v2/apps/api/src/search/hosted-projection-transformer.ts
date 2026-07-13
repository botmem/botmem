import {
  MediaDescriptorSchema,
  ParticipantSchema,
  SearchCandidateSchema,
  type SearchCandidate,
} from '@botmem-v2/contracts';
import { z } from 'zod';

const normalizedEmailSchema = z
  .object({
    sourceId: z.string().trim().min(1).max(2_048),
    title: z.string().trim().min(1).max(2_048).optional(),
    text: z.string().max(2_000_000),
    thread: z
      .object({
        durableId: z.string().trim().min(1).max(1_024),
        title: z.string().trim().min(1).max(1_024).optional(),
      })
      .strict()
      .optional(),
    participants: z.array(ParticipantSchema).max(256),
    media: z.array(MediaDescriptorSchema).max(128),
    authoredByMe: z.boolean().optional(),
  })
  .strict();

const emailPayloadSchema = z
  .object({
    schema: z.enum(['gmail.message.v1', 'outlook.message.v1']),
    normalized: normalizedEmailSchema,
  })
  .passthrough();

const ownTracksPayloadSchema = z
  .object({
    schema: z.literal('owntracks.location.v1'),
    location: z
      .object({
        latitude: z.number().finite().min(-90).max(90),
        longitude: z.number().finite().min(-180).max(180),
        accuracyMeters: z.number().finite().nonnegative().optional(),
        altitudeMeters: z.number().finite().optional(),
        velocityKilometersPerHour: z.number().finite().nonnegative().optional(),
        courseDegrees: z.number().finite().min(0).max(360).optional(),
      })
      .passthrough(),
  })
  .passthrough();

export interface HostedProjectionInput {
  readonly workspaceId: string;
  readonly accountId: string;
  readonly revisionId: string;
  readonly connector: 'gmail' | 'outlook' | 'owntracks';
  readonly sourceEventId: string;
  readonly sourceRevision: string;
  readonly kind: 'email' | 'location';
  readonly occurredAt: string | null;
  readonly tombstone: boolean;
  readonly payload: unknown;
}

export interface HostedProjectionMaterial {
  readonly candidate: SearchCandidate | null;
  readonly embeddingInput: string | null;
}

/** Converts immutable provider payloads into the one canonical hosted search shape. */
export function transformHostedProjection(input: HostedProjectionInput): HostedProjectionMaterial {
  if (input.tombstone) return Object.freeze({ candidate: null, embeddingInput: null });
  const candidate =
    input.connector === 'owntracks' ? locationCandidate(input) : emailCandidate(input);
  const embeddingInput = [candidate.title, candidate.text]
    .filter((value): value is string => Boolean(value))
    .join('\n')
    .slice(0, 8_000);
  if (!embeddingInput.trim()) throw new HostedProjectionTransformError('projection_text_empty');
  return Object.freeze({ candidate, embeddingInput });
}

function emailCandidate(input: HostedProjectionInput): SearchCandidate {
  if (input.kind !== 'email') throw new HostedProjectionTransformError('projection_kind_mismatch');
  const payload = emailPayloadSchema.parse(input.payload);
  const expectedSchema = input.connector === 'gmail' ? 'gmail.message.v1' : 'outlook.message.v1';
  if (payload.schema !== expectedSchema || payload.normalized.sourceId !== input.sourceEventId) {
    throw new HostedProjectionTransformError('projection_payload_mismatch');
  }
  for (const participant of payload.normalized.participants) {
    const durableEmails = participant.identifiers
      .filter((identifier) => identifier.kind === 'email')
      .map((identifier) => `email:${identifier.value.normalize('NFKC').toLowerCase()}`);
    if (!durableEmails.includes(participant.durableId)) {
      throw new HostedProjectionTransformError('participant_identifier_not_durable');
    }
  }
  return SearchCandidateSchema.parse({
    ref: `hosted:${input.revisionId}`,
    sourceId: input.sourceEventId,
    revision: input.sourceRevision,
    origin: { placement: 'hosted', connector: input.connector, accountId: input.accountId },
    kind: input.kind,
    occurredAt: input.occurredAt,
    ...(payload.normalized.title ? { title: payload.normalized.title } : {}),
    text: payload.normalized.text.slice(0, 20_000),
    ...(payload.normalized.thread ? { thread: payload.normalized.thread } : {}),
    participants: payload.normalized.participants,
    media: payload.normalized.media,
    ...(payload.normalized.authoredByMe === undefined
      ? {}
      : { authoredByMe: payload.normalized.authoredByMe }),
    citation: citation(input),
  });
}

function locationCandidate(input: HostedProjectionInput): SearchCandidate {
  if (input.kind !== 'location') {
    throw new HostedProjectionTransformError('projection_kind_mismatch');
  }
  const payload = ownTracksPayloadSchema.parse(input.payload);
  const location = payload.location;
  const details = [
    `latitude ${coordinate(location.latitude)}`,
    `longitude ${coordinate(location.longitude)}`,
    ...(location.altitudeMeters === undefined
      ? []
      : [`altitude ${coordinate(location.altitudeMeters)} meters`]),
    ...(location.accuracyMeters === undefined
      ? []
      : [`accuracy ${coordinate(location.accuracyMeters)} meters`]),
  ];
  return SearchCandidateSchema.parse({
    ref: `hosted:${input.revisionId}`,
    sourceId: input.sourceEventId,
    revision: input.sourceRevision,
    origin: { placement: 'hosted', connector: 'owntracks', accountId: input.accountId },
    kind: 'location',
    occurredAt: input.occurredAt,
    title: 'Location',
    text: details.join(', '),
    participants: [],
    media: [],
    citation: citation(input),
  });
}

function citation(input: HostedProjectionInput): string {
  return `botmem://hosted/${input.accountId}/${input.connector}/${encodeURIComponent(input.sourceEventId)}`;
}

function coordinate(value: number): string {
  return Number(value.toFixed(7)).toString();
}

export class HostedProjectionTransformError extends Error {
  override readonly name = 'HostedProjectionTransformError';

  constructor(readonly code: string) {
    super(code);
  }
}
