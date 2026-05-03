import { describe, expect, it, vi } from 'vitest';
import { PeoplePipelineService } from '../people-pipeline.service';
import type { ConnectorDataEvent, EmbedResult } from '@botmem/connector-sdk';

interface PipelineEvent {
  rawEventId: string;
  accountId: string;
  connectorType: string;
  sourceId: string;
  sourceType: string;
  payload: string;
  cleanedText: string | null;
  memoryId: string | null;
}

interface ProcessResult {
  resolved: number;
  linked: number;
  relationships: number;
  skipped: boolean;
  reason?: string;
}

interface TestablePeoplePipelineService {
  parseEvent(raw: { payload: string; sourceId: string }): ConnectorDataEvent | null;
  parseEntityIdentifiers(
    entity: { type: string; id: string; role: string },
    connectorType: string,
  ): Array<{ type: string; value: string; connectorType: string }>;
  processRawEvent(raw: PipelineEvent): Promise<ProcessResult>;
  resolveEntities(
    raw: PipelineEvent,
    event: ConnectorDataEvent,
    embedResult: EmbedResult,
  ): Promise<ProcessResult>;
  processWhatsAppGroupIdentity(
    raw: PipelineEvent,
    event: ConnectorDataEvent,
  ): Promise<ProcessResult>;
  buildPipelineContext(
    accountId: string,
    connectorType: string,
  ): Promise<{ auth: Record<string, unknown> }>;
}

function selectChain<T>(rows: T[]) {
  return {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(rows),
  };
}

function createService() {
  const db = {
    select: vi.fn(() => selectChain([{ userId: 'user-1' }])),
  };
  const dbService = {
    db,
    queryRaw: vi.fn(),
    systemDb: vi.fn(async (fn: (db: { delete: ReturnType<typeof vi.fn> }) => Promise<void>) => {
      const deleteChain = { where: vi.fn().mockResolvedValue(undefined) };
      await fn({ delete: vi.fn(() => deleteChain) });
    }),
  };
  const crypto = {
    decrypt: vi.fn((value: string | null) => {
      if (!value) return null;
      return value.startsWith('enc:') ? value.slice(4) : null;
    }),
  };
  const accountsService = {
    getById: vi.fn().mockResolvedValue({ authContext: '{"token":"ok"}' }),
  };
  const connector = {
    embed: vi.fn(),
  };
  const connectors = {
    get: vi.fn(() => connector),
  };
  let resolvedPersonIndex = 0;
  const peopleService = {
    resolvePerson: vi.fn(async () => ({ id: `person-${resolvedPersonIndex++}` })),
    linkMemory: vi.fn().mockResolvedValue(undefined),
    upsertRelationship: vi.fn().mockResolvedValue(undefined),
  };

  const service = new PeoplePipelineService(
    dbService as never,
    crypto as never,
    accountsService as never,
    connectors as never,
    peopleService as never,
  );

  return {
    service: service as unknown as PeoplePipelineService & TestablePeoplePipelineService,
    db,
    dbService,
    crypto,
    accountsService,
    connector,
    connectors,
    peopleService,
  };
}

function event(overrides: Partial<ConnectorDataEvent> = {}): ConnectorDataEvent {
  return {
    sourceType: 'message',
    sourceId: 'src-1',
    timestamp: '2026-05-03T10:00:00.000Z',
    content: { text: 'hello', metadata: {} },
    ...overrides,
  };
}

function raw(overrides: Partial<PipelineEvent> = {}): PipelineEvent {
  return {
    rawEventId: 'raw-1',
    accountId: 'acc-1',
    connectorType: 'gmail',
    sourceId: 'src-1',
    sourceType: 'message',
    payload: `enc:${JSON.stringify(event())}`,
    cleanedText: null,
    memoryId: 'mem-1',
    ...overrides,
  };
}

describe('PeoplePipelineService', () => {
  it('resets people graph tables and self contact settings', async () => {
    const { service, dbService } = createService();

    await service.resetPeopleGraph();

    expect(dbService.systemDb).toHaveBeenCalledTimes(1);
  });

  it('parses encrypted raw events and rejects malformed payloads', () => {
    const { service } = createService();

    expect(
      service.parseEvent({ payload: `enc:${JSON.stringify(event())}`, sourceId: 'override' })
        ?.sourceId,
    ).toBe('override');
    expect(service.parseEvent({ payload: 'enc:not-json', sourceId: 'bad' })).toBeNull();
  });

  it('splits typed and untyped entity identifiers', () => {
    const { service } = createService();

    expect(
      service.parseEntityIdentifiers(
        { type: 'person', id: 'email:A@example.com|phone:+971500000000|Amr Essam', role: 'sender' },
        'gmail',
      ),
    ).toEqual([
      { type: 'email', value: 'A@example.com', connectorType: 'gmail' },
      { type: 'phone', value: '+971500000000', connectorType: 'gmail' },
      { type: 'name', value: 'Amr Essam', connectorType: 'gmail' },
    ]);
  });

  it('builds connector context from account auth and connector logger', async () => {
    const { service } = createService();

    const ctx = await service.buildPipelineContext('acc-1', 'gmail');

    expect(ctx.auth).toEqual({ token: 'ok' });
  });

  it('creates people only from durable Gmail contact identifiers and links memories', async () => {
    const { service, peopleService } = createService();
    const result = await service.resolveEntities(
      raw({ sourceType: 'contact' }),
      event({ sourceType: 'contact' }),
      {
        text: 'Contact: Amr',
        entities: [
          { type: 'person', id: 'name:Only Name', role: 'participant' },
          { type: 'person', id: 'email:amr@example.com|name:Amr', role: 'participant' },
        ],
        metadata: {},
      },
    );

    expect(result).toMatchObject({ resolved: 1, linked: 1, skipped: false });
    expect(peopleService.resolvePerson).toHaveBeenCalledWith(
      [
        { type: 'email', value: 'amr@example.com', connectorType: 'gmail' },
        { type: 'name', value: 'Amr', connectorType: 'gmail' },
      ],
      undefined,
      'user-1',
    );
    expect(peopleService.linkMemory).toHaveBeenCalledWith('mem-1', 'person-0', 'participant');
  });

  it('does not create Gmail message people from name-only extracted entities', async () => {
    const { service, peopleService } = createService();

    const result = await service.resolveEntities(raw(), event(), {
      text: 'Hello Amr',
      entities: [{ type: 'person', id: 'name:Amr', role: 'mentioned' }],
      metadata: {},
    });

    expect(result).toMatchObject({
      resolved: 0,
      linked: 0,
      skipped: true,
      reason: 'message:no_people',
    });
    expect(peopleService.resolvePerson).not.toHaveBeenCalled();
  });

  it('processes raw events through connector embed and entity resolution', async () => {
    const { service, connector, crypto } = createService();
    connector.embed.mockResolvedValue({
      text: 'Hello',
      entities: [{ type: 'person', id: 'email:amr@example.com', role: 'sender' }],
      metadata: {},
    });

    const result = await service.processRawEvent(
      raw({ cleanedText: 'enc:decrypted text', payload: `enc:${JSON.stringify(event())}` }),
    );

    expect(result).toMatchObject({ resolved: 1, linked: 1 });
    expect(crypto.decrypt).toHaveBeenCalledWith('enc:decrypted text');
    expect(connector.embed).toHaveBeenCalledWith(
      expect.objectContaining({ sourceId: 'src-1' }),
      'decrypted text',
      expect.objectContaining({ auth: { token: 'ok' } }),
    );
  });

  it('creates WhatsApp group identities and member relationships', async () => {
    const { service, peopleService } = createService();
    const waEvent = event({
      sourceType: 'group',
      sourceId: 'wa-group:120363000000000000@g.us',
      content: {
        text: 'group',
        metadata: {
          groupJid: '120363000000000000@g.us',
          groupName: 'Friends',
          memberPhones: ['971500000001'],
          memberLids: ['abc123'],
        },
      },
    });

    const result = await service.processWhatsAppGroupIdentity(
      raw({
        connectorType: 'whatsapp',
        sourceType: 'group',
        sourceId: 'wa-group:120363000000000000@g.us',
        memoryId: null,
      }),
      waEvent,
    );

    expect(result).toMatchObject({ resolved: 3, relationships: 2, skipped: false });
    expect(peopleService.resolvePerson).toHaveBeenCalledWith(
      [
        { type: 'whatsapp_group_jid', value: '120363000000000000@g.us', connectorType: 'whatsapp' },
        { type: 'name', value: 'Friends', connectorType: 'whatsapp' },
      ],
      'group',
      'user-1',
    );
    expect(peopleService.upsertRelationship).toHaveBeenCalledTimes(2);
  });

  it('reports name-only people validation counts', async () => {
    const { service, dbService } = createService();
    dbService.queryRaw
      .mockResolvedValueOnce([{ count: '2' }])
      .mockResolvedValueOnce([{ count: '5' }]);

    await expect(service.validateNoNameOnlyPeople()).resolves.toEqual({
      nameOnlyPeople: 2,
      totalPeople: 5,
    });
  });
});
