import { describe, expect, it, vi } from 'vitest';
import {
  buildAskSynthesisPrompt,
  collectRelatedDocuments,
  synthesizeAskAnswer,
  type AskCitationInput,
} from '../ask-synthesis';

const baseCitation: AskCitationInput = {
  id: 'mem-1',
  text: 'Nouran said the offer was ready.',
  sourceType: 'message',
  connectorType: 'whatsapp',
  eventTime: new Date('2026-05-01T10:00:00.000Z'),
  factuality: { label: 'FACT', confidence: 0.9 },
  metadata: { chatId: 'chat-1', chatName: 'House purchase' },
  people: [{ role: 'sender', personId: 'p-1', displayName: 'Nouran' }],
  matchMode: 'hard_filter',
  topicCoverage: 1,
};

function attachmentStub(id: string, chatId: string): AskCitationInput {
  return {
    id,
    text: 'sent Offer_to_Purchase 307.pdf',
    sourceType: 'message',
    connectorType: 'whatsapp',
    eventTime: new Date('2026-05-01T10:05:00.000Z'),
    factuality: { label: 'UNVERIFIED' },
    metadata: {
      chatId,
      chatName: chatId === 'chat-1' ? 'House purchase' : 'Other chat',
      attachments: [{ fileName: 'Offer_to_Purchase 307.pdf', mimeType: 'application/pdf' }],
      senderName: 'Nouran',
    },
    textSource: 'metadata',
  };
}

describe('ask synthesis', () => {
  it('surfaces attachment stubs in the same conversation in relatedDocuments and prompt', () => {
    const relatedDocuments = collectRelatedDocuments(
      [baseCitation],
      [attachmentStub('doc-1', 'chat-1')],
    );
    const prompt = buildAskSynthesisPrompt('what was the offer?', [baseCitation], relatedDocuments);

    expect(relatedDocuments).toEqual([
      expect.objectContaining({
        fileName: 'Offer_to_Purchase 307.pdf',
        sender: 'Nouran',
        chatName: 'House purchase',
        memoryId: 'doc-1',
      }),
    ]);
    expect(prompt).toContain('Related documents (content not indexed)');
    expect(prompt).toContain('Offer_to_Purchase 307.pdf');
  });

  it('does not surface attachment stubs from other conversations', () => {
    expect(collectRelatedDocuments([baseCitation], [attachmentStub('doc-2', 'chat-2')])).toEqual(
      [],
    );
  });

  it('formats citation lines with connector, chat name, sender, date, and id', () => {
    const prompt = buildAskSynthesisPrompt('what happened?', [baseCitation], []);

    expect(prompt).toContain(
      '[1] whatsapp · House purchase · from Nouran · 2026-05-01T10:00:00.000Z · FACT · id=mem-1',
    );
  });

  it('returns structured citations from the answer path', async () => {
    const generate = vi.fn().mockResolvedValue('The offer was ready [1].');

    const result = await synthesizeAskAnswer({
      query: 'what was ready?',
      citations: [baseCitation],
      relatedDocuments: [],
      generate,
    });

    expect(result.answer).toBe('The offer was ready [1].');
    expect(result.citations).toEqual([
      expect.objectContaining({
        n: 1,
        memoryId: 'mem-1',
        connectorType: 'whatsapp',
        chatName: 'House purchase',
        sender: 'Nouran',
      }),
    ]);
  });

  it('instructs the model to surface unreadable documents without fabricating contents', () => {
    const prompt = buildAskSynthesisPrompt('what is in the document?', [baseCitation], [
      {
        fileName: 'Offer_to_Purchase 307.pdf',
        mimeType: 'application/pdf',
        sender: 'Nouran',
        date: '2026-05-01T10:05:00.000Z',
        chatName: 'House purchase',
        connectorType: 'whatsapp',
        memoryId: 'doc-1',
      },
    ]);

    expect(prompt).toContain('botmem cannot read their contents');
    expect(prompt).toContain('NEVER fabricate document contents');
  });
});
