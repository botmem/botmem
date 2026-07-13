import { describe, expect, it } from 'vitest';
import {
  HostedProjectionTransformError,
  transformHostedProjection,
  type HostedProjectionInput,
} from './hosted-projection-transformer.js';

const BASE: HostedProjectionInput = {
  workspaceId: '8e5ffcc7-8e8f-4aaa-9c77-b87a979c60cf',
  accountId: 'ae9af62a-c77a-43f7-b4c3-b8b0dd2b76f7',
  revisionId: '52b2ecba-3d9a-4c9d-89c8-e06c7916eec1',
  connector: 'gmail',
  sourceEventId: 'message-1',
  sourceRevision: 'history:1',
  kind: 'email',
  occurredAt: '2026-07-13T12:00:00.000Z',
  tombstone: false,
  payload: {},
};

describe('transformHostedProjection', () => {
  it('mapsNormalizedEmailWithoutInventingPersonIdentity', () => {
    const result = transformHostedProjection({
      ...BASE,
      payload: {
        schema: 'gmail.message.v1',
        normalized: {
          sourceId: 'message-1',
          title: 'Launch',
          text: 'Arabic العربية and English',
          participants: [
            {
              durableId: 'email:owner@example.com',
              displayName: 'Owner',
              role: 'sender',
              identifiers: [{ kind: 'email', value: 'owner@example.com' }],
            },
          ],
          media: [],
        },
      },
    });

    expect(result.candidate).toMatchObject({
      ref: `hosted:${BASE.revisionId}`,
      origin: { placement: 'hosted', connector: 'gmail', accountId: BASE.accountId },
      participants: [{ durableId: 'email:owner@example.com' }],
    });
    expect(result.embeddingInput).toBe('Launch\nArabic العربية and English');
  });

  it('rejectsNamesMasqueradingAsDurablePeople', () => {
    expect(() =>
      transformHostedProjection({
        ...BASE,
        payload: {
          schema: 'gmail.message.v1',
          normalized: {
            sourceId: 'message-1',
            text: 'hello',
            participants: [{ durableId: 'person:Alice', identifiers: [] }],
            media: [],
          },
        },
      }),
    ).toThrowError(HostedProjectionTransformError);
  });

  it('mapsOwnTracksCoordinatesAndMakesTombstonesContentFree', () => {
    const location = transformHostedProjection({
      ...BASE,
      connector: 'owntracks',
      sourceEventId: 'tst:1',
      sourceRevision: 'sha256:abc',
      kind: 'location',
      payload: {
        schema: 'owntracks.location.v1',
        location: { latitude: 25.2048493, longitude: 55.2707828, accuracyMeters: 10 },
      },
    });
    expect(location.candidate).toMatchObject({
      kind: 'location',
      text: 'latitude 25.2048493, longitude 55.2707828, accuracy 10 meters',
    });
    expect(transformHostedProjection({ ...BASE, tombstone: true })).toEqual({
      candidate: null,
      embeddingInput: null,
    });
  });
});
