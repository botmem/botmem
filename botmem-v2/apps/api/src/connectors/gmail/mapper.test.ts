import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { mapGmailMessage } from './mapper.js';

const hash = {
  sha256Hex: async (value: string) => createHash('sha256').update(value).digest('hex'),
};

describe('mapGmailMessage', () => {
  it('createsASearchableProjectionUsingOnlyDurableParticipantIdentifiers', async () => {
    const result = await mapGmailMessage(
      {
        id: 'message-1',
        threadId: 'thread-1',
        historyId: 'history-1',
        labelIds: ['SENT'],
        payload: {
          mimeType: 'multipart/mixed',
          headers: [
            { name: 'Subject', value: 'Launch notes' },
            { name: 'From', value: 'Owner Name <Owner@Example.com>' },
            { name: 'To', value: 'Teammate <team@example.com>' },
          ],
          parts: [
            {
              partId: 'body',
              mimeType: 'text/plain',
              body: { data: Buffer.from('Arabic العربية and English').toString('base64url') },
            },
            {
              partId: 'attachment-1',
              mimeType: 'application/pdf',
              filename: 'launch.pdf',
              body: { attachmentId: 'provider-attachment-1', size: 12 },
            },
          ],
        },
      },
      hash,
    );

    expect(result.payload).toMatchObject({
      schema: 'gmail.message.v1',
      normalized: {
        sourceId: 'message-1',
        title: 'Launch notes',
        text: 'Arabic العربية and English',
        thread: { durableId: 'gmail-thread:thread-1' },
        authoredByMe: true,
        participants: [
          {
            durableId: 'email:owner@example.com',
            role: 'sender',
            identifiers: [{ kind: 'email', value: 'owner@example.com' }],
          },
          {
            durableId: 'email:team@example.com',
            role: 'recipient',
            identifiers: [{ kind: 'email', value: 'team@example.com' }],
          },
        ],
        media: [
          {
            durableId: 'message-1:attachment:provider-attachment-1',
            mimeType: 'application/pdf',
            fileName: 'launch.pdf',
            sizeBytes: 12,
            availability: 'hosted',
          },
        ],
      },
    });
    expect(JSON.stringify(result.payload)).not.toContain('durableId":"Owner Name');
  });
});
