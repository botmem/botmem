import { describe, expect, it } from 'vitest';
import { DEVICE_PROTOCOL, MAX_DEVICE_FRAME_BYTES, parseDeviceFrame } from './device-protocol.js';

describe('device protocol contract', () => {
  it('parseDeviceFrame_whenSearchRequestIsValid_acceptsLocalQuery', () => {
    const frame = {
      protocol: DEVICE_PROTOCOL,
      requestId: 'e3654b66-d33d-471f-848b-e812ccafc5d6',
      sentAt: '2026-07-13T10:00:00.000Z',
      deadlineAt: '2026-07-13T10:00:01.000Z',
      type: 'search.request',
      payload: {
        queryId: 'c5815c51-b4dd-4e54-8909-b6c427dbf8f5',
        query: {
          query: 'launch',
          connectors: ['imessage', 'whatsapp'],
          limit: 20,
          cursor: null,
        },
      },
    };

    expect(parseDeviceFrame(JSON.stringify(frame))).toEqual(frame);
  });

  it('parseDeviceFrame_whenRemoteConnectorIsRequested_rejectsFrame', () => {
    const frame = {
      protocol: DEVICE_PROTOCOL,
      requestId: 'e3654b66-d33d-471f-848b-e812ccafc5d6',
      sentAt: '2026-07-13T10:00:00.000Z',
      deadlineAt: '2026-07-13T10:00:01.000Z',
      type: 'search.request',
      payload: {
        queryId: 'c5815c51-b4dd-4e54-8909-b6c427dbf8f5',
        query: {
          query: 'launch',
          connectors: ['gmail'],
          limit: 20,
          cursor: null,
        },
      },
    };

    expect(() => parseDeviceFrame(JSON.stringify(frame))).toThrow();
  });

  it('parseDeviceFrame_whenDeadlineIsNotAfterSentTime_rejectsFrame', () => {
    const frame = {
      protocol: DEVICE_PROTOCOL,
      requestId: 'e3654b66-d33d-471f-848b-e812ccafc5d6',
      sentAt: '2026-07-13T10:00:00.000Z',
      deadlineAt: '2026-07-13T10:00:00.000Z',
      type: 'heartbeat',
      payload: {
        sessionId: '85ce735f-eac5-48f1-86c1-f3cc25ad51dd',
        sequence: 1,
      },
    };

    expect(() => parseDeviceFrame(JSON.stringify(frame))).toThrow(/deadline/);
  });

  it('parseDeviceFrame_whenPayloadExceedsLimit_rejectsBeforeParsing', () => {
    const oversized = new Uint8Array(MAX_DEVICE_FRAME_BYTES + 1);

    expect(() => parseDeviceFrame(oversized)).toThrow(/maximum payload/);
  });
});
