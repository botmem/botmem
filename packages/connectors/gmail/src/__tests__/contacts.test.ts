import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SyncContext, ConnectorDataEvent, ProgressEvent } from '@botmem/connector-sdk';

const mockConnectionsList = vi.hoisted(() => vi.fn());

vi.mock('googleapis', () => ({
  google: {
    auth: {
      OAuth2: vi.fn().mockImplementation(() => ({
        setCredentials: vi.fn(),
      })),
    },
    people: vi.fn().mockReturnValue({
      people: {
        connections: {
          list: mockConnectionsList,
        },
      },
    }),
  },
}));

import { syncContacts } from '../contacts.js';

function makeCtx(overrides: Record<string, unknown> = {}): SyncContext {
  return {
    accountId: 'acc-1',
    auth: { accessToken: 'tok', refreshToken: 'rt' },
    cursor: null,
    jobId: 'j1',
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    signal: AbortSignal.timeout(5000),
    ...overrides,
  } as SyncContext;
}

const makeContact = (overrides: Record<string, unknown> = {}) => ({
  resourceName: 'people/c1',
  names: [{ displayName: 'Alice Smith', givenName: 'Alice', familyName: 'Smith' }],
  emailAddresses: [{ value: 'alice@test.com' }],
  phoneNumbers: [{ value: '+1234567890', type: 'mobile' }],
  organizations: [{ name: 'Acme', title: 'Engineer', department: 'Eng' }],
  addresses: [{ formattedValue: '123 Main St' }],
  birthdays: [{ date: { year: 1990, month: 6, day: 15 } }],
  biographies: [{ value: 'A bio' }],
  urls: [{ value: 'https://alice.dev' }],
  relations: [{ person: 'Bob', type: 'spouse' }],
  nicknames: [{ value: 'Ali' }],
  photos: [{ url: 'https://photo.com/alice.jpg' }],
  sipAddresses: [{ value: 'sip:alice@test' }],
  imClients: [{ username: 'alice_im', protocol: 'xmpp' }],
  occupations: [{ value: 'Software Engineer' }],
  interests: [{ value: 'hiking' }],
  genders: [{ value: 'female' }],
  externalIds: [{ value: 'ext-123', type: 'account' }],
  userDefined: [{ key: 'custom', value: 'val' }],
  events: [{ type: 'anniversary', date: { year: 2020, month: 1, day: 1 } }],
  metadata: { sources: [{ updateTime: '2025-01-01T00:00:00Z' }] },
  ...overrides,
});

describe('syncContacts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('syncs contacts and emits events with rich metadata', async () => {
    // First call is for total count, second for actual data
    mockConnectionsList
      .mockResolvedValueOnce({
        data: { totalPeople: 1, connections: [] },
      })
      .mockResolvedValueOnce({
        data: { connections: [makeContact()], nextPageToken: undefined },
      });

    const events: ConnectorDataEvent[] = [];
    const progress: ProgressEvent[] = [];

    const result = await syncContacts(
      makeCtx(),
      (e) => events.push(e),
      (p) => progress.push(p),
    );

    expect(result.processed).toBe(1);
    expect(events).toHaveLength(1);

    const event = events[0];
    expect(event.sourceType).toBe('message');
    expect(event.sourceId).toBe('people/c1');
    expect(event.content.text).toContain('Contact: Alice Smith');
    expect(event.content.text).toContain('Email: alice@test.com');
    expect(event.content.text).toContain('Phone: +1234567890 (mobile)');
    expect(event.content.text).toContain('Organization: Acme — Engineer — Eng');
    expect(event.content.text).toContain('Birthday: 1990-06-15');
    expect(event.content.text).toContain('Bio: A bio');
    expect(event.content.text).toContain('Nicknames: Ali');
    expect(event.content.text).toContain('Relations: Bob (spouse)');
    expect(event.content.text).toContain('SIP: sip:alice@test');
    expect(event.content.text).toContain('IM: alice_im (xmpp)');
    expect(event.content.text).toContain('Occupation: Software Engineer');
    expect(event.content.text).toContain('Interests: hiking');
    expect(event.content.text).toContain('Gender: female');
    expect(event.content.text).toContain('Events: anniversary: 2020-01-01');
    expect(event.content.text).toContain('External IDs: ext-123 (account)');
    expect(event.content.text).toContain('Custom: custom: val');

    expect(event.content.metadata.type).toBe('contact');
    expect(event.content.metadata.name).toBe('Alice Smith');
    expect(event.content.metadata.photoUrl).toBe('https://photo.com/alice.jpg');
    expect(event.content.participants).toContain('Alice Smith');
    expect(event.content.participants).toContain('alice@test.com');
  });

  it('handles empty contact list', async () => {
    mockConnectionsList
      .mockResolvedValueOnce({ data: { totalPeople: 0, connections: [] } })
      .mockResolvedValueOnce({ data: { connections: [], nextPageToken: undefined } });

    const events: ConnectorDataEvent[] = [];
    const result = await syncContacts(makeCtx(), (e) => events.push(e), vi.fn());

    expect(result.processed).toBe(0);
    expect(events).toHaveLength(0);
  });

  it('handles total count fetch failure', async () => {
    mockConnectionsList
      .mockRejectedValueOnce(new Error('API disabled'))
      .mockResolvedValueOnce({ data: { connections: [makeContact()], nextPageToken: undefined } });

    const events: ConnectorDataEvent[] = [];
    const ctx = makeCtx();
    const result = await syncContacts(ctx, (e) => events.push(e), vi.fn());

    expect(ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to get contacts count'),
    );
    expect(result.processed).toBe(1);
  });

  it('handles connections list failure', async () => {
    mockConnectionsList
      .mockResolvedValueOnce({ data: { totalPeople: 5 } })
      .mockRejectedValueOnce(new Error('Rate limited'));

    const ctx = makeCtx();
    const result = await syncContacts(ctx, vi.fn(), vi.fn());

    expect(ctx.logger.error).toHaveBeenCalledWith(expect.stringContaining('Contacts list failed'));
    expect(result.processed).toBe(0);
  });

  it('paginates through multiple pages', async () => {
    mockConnectionsList
      .mockResolvedValueOnce({ data: { totalPeople: 2 } })
      .mockResolvedValueOnce({
        data: { connections: [makeContact()], nextPageToken: 'page2' },
      })
      .mockResolvedValueOnce({
        data: {
          connections: [
            makeContact({ resourceName: 'people/c2', names: [{ displayName: 'Bob' }] }),
          ],
          nextPageToken: undefined,
        },
      });

    const events: ConnectorDataEvent[] = [];
    const result = await syncContacts(makeCtx(), (e) => events.push(e), vi.fn());
    expect(result.processed).toBe(2);
    expect(events).toHaveLength(2);
  });

  it('handles minimal contact (no optional fields)', async () => {
    const minimal = {
      resourceName: 'people/c3',
      names: [{ displayName: 'Unknown' }],
    };
    mockConnectionsList
      .mockResolvedValueOnce({ data: { totalPeople: 1 } })
      .mockResolvedValueOnce({ data: { connections: [minimal], nextPageToken: undefined } });

    const events: ConnectorDataEvent[] = [];
    await syncContacts(makeCtx(), (e) => events.push(e), vi.fn());

    expect(events[0].content.text).toBe('Contact: Unknown');
    expect(events[0].content.metadata.emails).toEqual([]);
  });

  it('handles contact with no name (falls back to Unknown)', async () => {
    const noName = { resourceName: 'people/c4' };
    mockConnectionsList
      .mockResolvedValueOnce({ data: { totalPeople: 1 } })
      .mockResolvedValueOnce({ data: { connections: [noName], nextPageToken: undefined } });

    const events: ConnectorDataEvent[] = [];
    await syncContacts(makeCtx(), (e) => events.push(e), vi.fn());
    expect(events[0].content.metadata.name).toBe('Unknown');
  });

  it('uses clientId/clientSecret from auth.raw when available', async () => {
    mockConnectionsList
      .mockResolvedValueOnce({ data: { totalPeople: 0 } })
      .mockResolvedValueOnce({ data: { connections: [], nextPageToken: undefined } });

    const ctx = makeCtx({
      auth: {
        accessToken: 'tok',
        refreshToken: 'rt',
        raw: { clientId: 'cid', clientSecret: 'cs' },
      },
    });

    await syncContacts(ctx, vi.fn(), vi.fn());
    expect(mockConnectionsList).toHaveBeenCalled();
  });

  it('handles birthday with missing year', async () => {
    const contact = makeContact({
      birthdays: [{ date: { month: 12, day: 25 } }],
    });
    mockConnectionsList
      .mockResolvedValueOnce({ data: { totalPeople: 1 } })
      .mockResolvedValueOnce({ data: { connections: [contact], nextPageToken: undefined } });

    const events: ConnectorDataEvent[] = [];
    await syncContacts(makeCtx(), (e) => events.push(e), vi.fn());
    expect(events[0].content.text).toContain('Birthday: ????-12-25');
  });

  it('falls back to contact-N sourceId when no resourceName', async () => {
    const contact = makeContact({ resourceName: undefined });
    mockConnectionsList
      .mockResolvedValueOnce({ data: { totalPeople: 1 } })
      .mockResolvedValueOnce({ data: { connections: [contact], nextPageToken: undefined } });

    const events: ConnectorDataEvent[] = [];
    await syncContacts(makeCtx(), (e) => events.push(e), vi.fn());
    expect(events[0].sourceId).toBe('contact-0');
  });
});
