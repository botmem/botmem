import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildWhatsAppGroupIdentity,
  shouldMergeEntityResolutionBucket,
} from '../connector-normalizers/whatsapp-group-identity';
import { buildWhatsAppContactIdentity } from '../connector-normalizers/whatsapp-contact-identity';
import { MemoryProcessor } from '../memory.processor';

describe('shouldMergeEntityResolutionBucket', () => {
  it('never fuses person entities before person resolution', () => {
    expect(
      shouldMergeEntityResolutionBucket(
        'person',
        'participant',
        {
          entityType: 'person',
          role: 'participant',
          identifiers: [
            { type: 'name', value: 'Amr', connectorType: 'whatsapp' },
            { type: 'phone', value: '+971502284498', connectorType: 'whatsapp' },
          ],
        },
        [
          { type: 'name', value: 'Amr', connectorType: 'whatsapp' },
          { type: 'phone', value: '+971504024690', connectorType: 'whatsapp' },
        ],
      ),
    ).toBe(false);
  });

  it('uses typed identifier equality for non-person entity buckets', () => {
    expect(
      shouldMergeEntityResolutionBucket(
        'group',
        'group',
        {
          entityType: 'group',
          role: 'group',
          identifiers: [{ type: 'whatsapp_group_jid', value: '120363', connectorType: 'whatsapp' }],
        },
        [{ type: 'whatsapp_group_jid', value: '120363', connectorType: 'whatsapp' }],
      ),
    ).toBe(true);

    expect(
      shouldMergeEntityResolutionBucket(
        'group',
        'group',
        {
          entityType: 'group',
          role: 'group',
          identifiers: [{ type: 'name', value: '120363', connectorType: 'whatsapp' }],
        },
        [{ type: 'whatsapp_group_jid', value: '120363', connectorType: 'whatsapp' }],
      ),
    ).toBe(false);
  });
});

describe('buildWhatsAppGroupIdentity', () => {
  it('preserves WhatsApp group members as people and the group as a group', () => {
    const result = buildWhatsAppGroupIdentity({
      sourceType: 'contact',
      sourceId: 'wa-group:120363000000000000@g.us',
      timestamp: new Date().toISOString(),
      content: {
        text: 'WhatsApp group: Friends',
        metadata: {
          name: 'Friends',
          groupJid: '120363000000000000@g.us',
          memberPhones: ['971500000001'],
          memberLids: ['123456789'],
          memberJids: ['971500000002@s.whatsapp.net', '987654321@lid'],
        },
      },
    });

    expect(result?.groupIdentifiers).toContainEqual({
      type: 'whatsapp_group_jid',
      value: '120363000000000000@g.us',
      connectorType: 'whatsapp',
    });
    expect(result?.groupIdentifiers).toContainEqual({
      type: 'name',
      value: 'Friends',
      connectorType: 'whatsapp',
    });
    expect(result?.members.map((m) => m.identifiers[0])).toEqual(
      expect.arrayContaining([
        { type: 'phone', value: '+971500000001', connectorType: 'whatsapp' },
        { type: 'phone', value: '+971500000002', connectorType: 'whatsapp' },
        { type: 'whatsapp_lid', value: '123456789', connectorType: 'whatsapp' },
        { type: 'whatsapp_lid', value: '987654321', connectorType: 'whatsapp' },
      ]),
    );
  });
});

describe('buildWhatsAppContactIdentity', () => {
  it('turns WhatsApp contact metadata into durable person identifiers', () => {
    const result = buildWhatsAppContactIdentity(
      {
        sourceType: 'contact',
        sourceId: 'wa-contact:971508556252',
        timestamp: new Date().toISOString(),
        content: {
          text: 'WhatsApp contact: Moataz Aly (+971508556252)',
          participants: ['971508556252'],
          metadata: {
            type: 'contact',
            name: 'Moataz Aly',
            phone: '971508556252',
            whatsappLid: '49293440377068@lid',
          },
        },
      },
      'whatsapp',
    );

    expect(result?.identifiers).toEqual([
      { type: 'phone', value: '+971508556252', connectorType: 'whatsapp' },
      { type: 'whatsapp_lid', value: '49293440377068', connectorType: 'whatsapp' },
      { type: 'name', value: 'Moataz Aly', connectorType: 'whatsapp' },
    ]);
  });

  it('refuses name-only WhatsApp contacts', () => {
    const result = buildWhatsAppContactIdentity(
      {
        sourceType: 'contact',
        sourceId: 'wa-contact:unknown',
        timestamp: new Date().toISOString(),
        content: {
          text: 'WhatsApp contact: Unknown',
          metadata: { type: 'contact', name: 'Unknown' },
        },
      },
      'whatsapp',
    );

    expect(result).toBeNull();
  });
});

describe('media extraction metadata', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('represents message media as a file memory with connector provenance and extraction evidence', () => {
    const proto = MemoryProcessor.prototype as unknown as {
      memorySourceTypeForEvent(sourceType: string, media: unknown): string;
      buildMediaMemoryText(input: {
        connectorType: string;
        originalSourceType: string;
        media: {
          kind: string;
          mimeType: string;
          fileName?: string;
          hasInlineContent: boolean;
          hasFetchableUrl: boolean;
        };
        metadata: Record<string, unknown>;
        originalText: string;
        currentText: string;
      }): string;
    };
    const media = {
      kind: 'image',
      mimeType: 'image/jpeg',
      fileName: 'receipt.jpg',
      hasInlineContent: true,
      hasFetchableUrl: false,
    };

    expect(proto.memorySourceTypeForEvent('message', media)).toBe('file');

    const text = proto.buildMediaMemoryText({
      connectorType: 'whatsapp',
      originalSourceType: 'message',
      media,
      metadata: {
        mediaExtraction: {
          extractedText: 'Visible total: AED 120',
          confidenceLabel: 'medium',
          warnings: ['ocr_date_disagrees_with_event_time'],
        },
      },
      originalText: 'Mom sent an image',
      currentText: 'Visible total: AED 120\n\nMom sent an image',
    });

    expect(text).toContain('File from WhatsApp');
    expect(text).toContain('Connector: whatsapp');
    expect(text).toContain('Original source type: message');
    expect(text).toContain('Extracted media text (medium confidence):');
    expect(text).toContain('Visible total: AED 120');
    expect(text).toContain('Extraction warnings: ocr_date_disagrees_with_event_time');
  });

  it('records low-confidence warnings when OCR dates disagree with event time', () => {
    const metadata = (
      MemoryProcessor.prototype as unknown as {
        buildMediaExtractionMetadata(input: {
          status: string;
          source: string;
          extractedText?: string;
          eventTimestamp?: string;
        }): Record<string, unknown>;
      }
    ).buildMediaExtractionMetadata({
      status: 'extracted',
      source: 'vision_ocr',
      extractedText: 'Official document dated 2021',
      eventTimestamp: '2026-05-01T00:00:00.000Z',
    });

    expect(metadata.confidenceLabel).toBe('low');
    expect(metadata.warnings).toContain('ocr_date_disagrees_with_event_time');
    expect(metadata.extractedText).toContain('Official document');
  });

  it('treats Gmail attachment URIs as fetchable media', () => {
    const media = (
      MemoryProcessor.prototype as unknown as {
        resolvePrimaryMedia(
          metadata: Record<string, unknown>,
          sourceType: unknown,
        ): {
          kind: string;
          mimeType: string;
          fileName?: string;
          hasInlineContent: boolean;
          hasFetchableUrl: boolean;
          connectorUri?: string;
        } | null;
      }
    ).resolvePrimaryMedia(
      {
        attachments: [
          {
            uri: 'gmail://attachment/att-123',
            mimeType: 'application/pdf',
            filename: 'Flight Booking.pdf',
          },
        ],
      },
      'email',
    );

    expect(media).toEqual({
      kind: 'file',
      mimeType: 'application/pdf',
      fileName: 'Flight Booking.pdf',
      hasInlineContent: false,
      hasFetchableUrl: false,
      connectorUri: 'gmail://attachment/att-123',
    });
  });

  it('downloads Gmail attachment bytes from the Gmail API', async () => {
    const processor = Object.create(MemoryProcessor.prototype) as {
      fetchGmailAttachment(
        connectorUri: string,
        rawEvent: { accountId: string; connectorType: string; sourceId: string },
      ): Promise<Buffer>;
      buildAuthHeaders: () => Promise<Record<string, string>>;
    };
    processor.buildAuthHeaders = vi
      .fn()
      .mockResolvedValue({ Authorization: 'Bearer access-token' });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ data: Buffer.from('pdf bytes').toString('base64url') }),
    } as Response);

    const buffer = await processor.fetchGmailAttachment('gmail://attachment/att-123', {
      accountId: 'account-1',
      connectorType: 'gmail',
      sourceId: 'message-1',
    });

    expect(buffer.toString()).toBe('pdf bytes');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://gmail.googleapis.com/gmail/v1/users/me/messages/message-1/attachments/att-123',
      expect.objectContaining({
        headers: { Authorization: 'Bearer access-token' },
      }),
    );
  });

  it('refreshes expired Gmail OAuth tokens before building auth headers', async () => {
    const accountsService = {
      getById: vi.fn().mockResolvedValue({
        authContext: JSON.stringify({
          accessToken: 'expired-token',
          refreshToken: 'refresh-token',
          expiresAt: '2020-01-01T00:00:00.000Z',
          raw: {
            clientId: 'client-id',
            clientSecret: 'client-secret',
            redirectUri: 'https://example.com/callback',
          },
        }),
      }),
      update: vi.fn().mockResolvedValue({}),
    };
    const processor = Object.create(MemoryProcessor.prototype) as {
      accountsService: typeof accountsService;
      buildAuthHeaders(accountId: string, connectorType: string): Promise<Record<string, string>>;
    };
    processor.accountsService = accountsService;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'fresh-token', expires_in: 3600 }),
    } as Response);

    const headers = await processor.buildAuthHeaders('account-1', 'gmail');

    expect(headers).toEqual({ Authorization: 'Bearer fresh-token' });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://oauth2.googleapis.com/token',
      expect.objectContaining({
        method: 'POST',
        body: expect.any(URLSearchParams),
      }),
    );
    const savedAuth = JSON.parse(accountsService.update.mock.calls[0][1].authContext);
    expect(savedAuth.accessToken).toBe('fresh-token');
    expect(savedAuth.refreshToken).toBe('refresh-token');
    expect(new Date(savedAuth.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('uses connector-native attachments before generic URLs', async () => {
    const processor = Object.create(MemoryProcessor.prototype) as {
      getFileBuffer(
        metadata: Record<string, unknown>,
        rawEvent: { accountId: string; connectorType: string; sourceId: string },
      ): Promise<Buffer>;
      fetchConnectorAttachment: () => Promise<Buffer>;
    };
    processor.fetchConnectorAttachment = vi.fn().mockResolvedValue(Buffer.from('attachment'));
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    const buffer = await processor.getFileBuffer(
      {
        fileUrl: 'https://example.com/should-not-be-fetched.pdf',
        attachments: [{ uri: 'gmail://attachment/att-123', mimeType: 'application/pdf' }],
      },
      { accountId: 'account-1', connectorType: 'gmail', sourceId: 'message-1' },
    );

    expect(buffer.toString()).toBe('attachment');
    expect(processor.fetchConnectorAttachment).toHaveBeenCalledWith('gmail://attachment/att-123', {
      accountId: 'account-1',
      connectorType: 'gmail',
      sourceId: 'message-1',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('downloads photos connector attachments through the connector raw asset API', async () => {
    const getRawAsset = vi.fn().mockResolvedValue({
      contentType: 'image/jpeg',
      contentLength: 11,
      fileName: 'IMG_0001.JPG.preview',
      buffer: Buffer.from('image bytes'),
    });
    const accountsService = {
      getById: vi.fn().mockResolvedValue({
        authContext: JSON.stringify({
          accessToken: 'immich-api-key',
          raw: { host: 'https://photos.example' },
        }),
      }),
    };
    const processor = Object.create(MemoryProcessor.prototype) as {
      accountsService: typeof accountsService;
      connectors: { get: ReturnType<typeof vi.fn> };
      getFileBuffer(
        metadata: Record<string, unknown>,
        rawEvent: { accountId: string; connectorType: string; sourceId: string },
      ): Promise<Buffer>;
    };
    processor.accountsService = accountsService;
    processor.connectors = {
      get: vi.fn().mockReturnValue({ getRawAsset }),
    };
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    const buffer = await processor.getFileBuffer(
      {
        fileUrl: 'https://photos.example/api/assets/asset-1/thumbnail?size=preview',
        attachments: [
          {
            uri: 'https://photos.example/api/assets/asset-1/thumbnail?size=preview',
            mimeType: 'image/jpeg',
          },
        ],
      },
      { accountId: 'account-1', connectorType: 'photos', sourceId: 'asset-1' },
    );

    expect(buffer.toString()).toBe('image bytes');
    expect(processor.connectors.get).toHaveBeenCalledWith('photos');
    expect(getRawAsset).toHaveBeenCalledWith(
      'asset-1',
      { accessToken: 'immich-api-key', raw: { host: 'https://photos.example' } },
      'thumbnail',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('downgrades factuality when media extraction is low-confidence', () => {
    const factuality = (
      MemoryProcessor.prototype as unknown as {
        guardMediaFactuality(
          factuality: { label: string; confidence: number; rationale: string },
          metadata: Record<string, unknown>,
        ): { label: string; confidence: number; rationale: string };
      }
    ).guardMediaFactuality(
      { label: 'FACT', confidence: 0.95, rationale: 'Model said so' },
      {
        mediaExtraction: {
          confidence: 0.45,
          warnings: ['ocr_date_disagrees_with_event_time'],
        },
      },
    );

    expect(factuality.label).toBe('UNVERIFIED');
    expect(factuality.confidence).toBeLessThan(0.6);
    expect(factuality.rationale).toContain('ocr_date_disagrees_with_event_time');
  });

  it('represents linked documents as file memories with connector provenance', () => {
    const proto = MemoryProcessor.prototype as unknown as {
      buildLinkedDocumentMemoryText(input: {
        connectorType: string;
        originalSourceType: string;
        documents: Record<string, unknown>[];
        originalText: string;
        currentText: string;
      }): string;
    };

    const text = proto.buildLinkedDocumentMemoryText({
      connectorType: 'whatsapp',
      originalSourceType: 'message',
      originalText: 'Here is the document link',
      currentText: 'raw search text',
      documents: [
        {
          status: 'extracted',
          fileName: 'certificate.pdf',
          mimeType: 'application/pdf',
          searchSummary: 'Official certificate details',
          extractedText: 'Certificate number 123',
        },
      ],
    });

    expect(text).toContain('File from WhatsApp');
    expect(text).toContain('Connector: whatsapp');
    expect(text).toContain('Original source type: message');
    expect(text).toContain('Linked file 1');
    expect(text).toContain('Filename: certificate.pdf');
    expect(text).toContain('Extracted document text:');
  });
});

describe('email thread aggregate helpers', () => {
  it('normalizes Re/Fwd chains into one canonical thread summary', () => {
    const proto = MemoryProcessor.prototype as unknown as {
      buildEmailThreadAggregateText(input: {
        subject?: string;
        messages: Array<{ eventTime: Date; text: string }>;
      }): string;
    };

    const text = proto.buildEmailThreadAggregateText({
      subject: 'Booking update',
      messages: [
        {
          eventTime: new Date('2026-05-02T12:00:00.000Z'),
          text: 'Re: Booking update\nThe booking is confirmed.',
        },
        {
          eventTime: new Date('2026-05-01T09:00:00.000Z'),
          text: 'Fwd: Booking update\nInitial request with passenger details.',
        },
      ],
    });

    expect(text).toContain('Email thread: Booking update');
    expect(text).toContain('Latest state:');
    expect(text).toContain('The booking is confirmed');
    expect(text).toContain('Messages: 2');
    expect(text.indexOf('2026-05-01T09:00:00.000Z')).toBeLessThan(
      text.indexOf('2026-05-02T12:00:00.000Z'),
    );
  });
});
