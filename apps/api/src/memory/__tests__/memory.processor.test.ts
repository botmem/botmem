import { describe, expect, it } from 'vitest';
import {
  buildWhatsAppGroupIdentity,
  shouldMergeEntityResolutionBucket,
} from '../connector-normalizers/whatsapp-group-identity';
import { buildWhatsAppContactIdentity } from '../connector-normalizers/whatsapp-contact-identity';

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
