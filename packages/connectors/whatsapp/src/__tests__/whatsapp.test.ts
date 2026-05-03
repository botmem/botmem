import { describe, it, expect } from 'vitest';
import { WhatsAppConnector } from '../index';

describe('WhatsAppConnector', () => {
  it('does not treat the self participant as the sender for incoming LID-only DMs', () => {
    const connector = new WhatsAppConnector();
    const result = connector.embed(
      {
        sourceType: 'message',
        sourceId: 'wa-msg:1',
        timestamp: new Date().toISOString(),
        content: {
          text: 'hello',
          participants: ['971502284498'],
          metadata: {
            chatId: '158226779779147@lid',
            senderName: 'Ahmed Elsalnawy',
            senderLid: '158226779779147',
            senderPhone: '',
            fromMe: false,
            isGroup: false,
            selfPhone: '971502284498',
          },
        },
      },
      'hello',
      {} as never,
    );

    expect(result.entities).toContainEqual({
      type: 'person',
      id: 'whatsapp_lid:158226779779147|name:Ahmed Elsalnawy',
      role: 'sender',
    });
    expect(result.entities).toContainEqual({
      type: 'person',
      id: 'phone:971502284498',
      role: 'recipient',
    });
    expect(result.entities).not.toContainEqual({
      type: 'person',
      id: 'phone:971502284498|name:Ahmed Elsalnawy',
      role: 'sender',
    });
  });

  it('links outgoing LID-only DMs to the chat recipient instead of dropping the recipient', () => {
    const connector = new WhatsAppConnector();
    const result = connector.embed(
      {
        sourceType: 'message',
        sourceId: 'wa-msg:2',
        timestamp: new Date().toISOString(),
        content: {
          text: 'hello',
          participants: ['971502284498'],
          metadata: {
            chatId: '158226779779147@lid',
            senderName: 'Amr Essam',
            senderPhone: '971502284498',
            fromMe: true,
            isGroup: false,
            selfPhone: '971502284498',
          },
        },
      },
      'hello',
      {} as never,
    );

    expect(result.entities).toContainEqual({
      type: 'person',
      id: 'phone:971502284498|name:Amr Essam',
      role: 'sender',
    });
    expect(result.entities).toContainEqual({
      type: 'person',
      id: 'whatsapp_lid:158226779779147',
      role: 'recipient',
    });
  });

  it('does not also emit the outgoing DM recipient as a generic participant', () => {
    const connector = new WhatsAppConnector();
    const result = connector.embed(
      {
        sourceType: 'message',
        sourceId: 'wa-msg:3',
        timestamp: new Date().toISOString(),
        content: {
          text: 'hello',
          participants: ['971502284498', '16282448544'],
          metadata: {
            chatId: '16282448544@c.us',
            senderName: 'Amr Essam',
            senderPhone: '971502284498',
            fromMe: true,
            isGroup: false,
            selfPhone: '971502284498',
          },
        },
      },
      'hello',
      {} as never,
    );

    expect(result.entities).toContainEqual({
      type: 'person',
      id: 'phone:16282448544',
      role: 'recipient',
    });
    expect(result.entities).not.toContainEqual({
      type: 'person',
      id: 'phone:16282448544',
      role: 'participant',
    });
  });

  it('turns WhatsApp contact identity events into one person with phone and LID identifiers', () => {
    const connector = new WhatsAppConnector();
    const result = connector.embed(
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
            phones: ['971508556252'],
            whatsappLid: '49293440377068',
            whatsappLids: ['49293440377068'],
            connectorType: 'whatsapp',
          },
        },
      },
      'WhatsApp contact: Moataz Aly (+971508556252)',
      {} as never,
    );

    expect(result.entities).toEqual([
      {
        type: 'person',
        id: 'phone:971508556252|whatsapp_lid:49293440377068|name:Moataz Aly',
        role: 'contact',
      },
    ]);
  });
});
