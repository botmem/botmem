export interface AskCitationInput {
  id: string;
  text: string;
  sourceType: string;
  connectorType: string;
  eventTime: Date;
  factuality: unknown;
  metadata: unknown;
  people?: { role: string; personId?: string; displayName: string }[];
  matchedContactRoles?: string[];
  matchMode?: 'hard_filter' | 'hint' | 'fallback';
  topicCoverage?: number;
  textSource?: 'body' | 'attachment_ocr' | 'metadata';
}

export interface StructuredAskCitation {
  n: number;
  memoryId: string;
  connectorType: string;
  chatName: string | null;
  sender: string | null;
  date: string;
  factuality: string;
  snippet: string;
}

export interface RelatedDocument {
  fileName: string;
  mimeType: string | null;
  sender: string | null;
  date: string;
  chatName: string | null;
  connectorType: string;
  memoryId: string;
}

function objectValue(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function factualityLabel(value: unknown): string {
  const object = objectValue(value);
  return stringValue(object.label) ?? stringValue(value) ?? 'UNVERIFIED';
}

function attachmentsOf(value: AskCitationInput): Record<string, unknown>[] {
  const raw = objectValue(value.metadata).attachments;
  return Array.isArray(raw)
    ? raw.filter(
        (item): item is Record<string, unknown> =>
          !!item && typeof item === 'object' && !Array.isArray(item),
      )
    : [];
}

function attachmentName(attachment: Record<string, unknown>): string | null {
  return (
    stringValue(attachment.fileName) ??
    stringValue(attachment.filename) ??
    stringValue(attachment.name)
  );
}

function attachmentMimeType(attachment: Record<string, unknown>): string | null {
  return stringValue(attachment.mimeType) ?? stringValue(attachment.contentType);
}

function senderFor(item: AskCitationInput): string | null {
  const sender = item.people?.find((person) => person.role === 'sender')?.displayName;
  const firstPerson = item.people?.find((person) => person.displayName)?.displayName;
  const metadata = objectValue(item.metadata);
  return (
    stringValue(sender) ??
    stringValue(metadata.senderName) ??
    stringValue(metadata.from) ??
    stringValue(firstPerson)
  );
}

function chatNameFor(item: AskCitationInput): string | null {
  const metadata = objectValue(item.metadata);
  return (
    stringValue(metadata.chatName) ??
    stringValue(metadata.groupName) ??
    stringValue(metadata.threadSubject) ??
    stringValue(metadata.subject) ??
    stringValue(metadata.emailThreadKey) ??
    stringValue(metadata.threadId) ??
    stringValue(metadata.thread_id) ??
    stringValue(metadata.chatId)
  );
}

export function conversationKeysFor(item: AskCitationInput): string[] {
  return conversationIdsFor(item).map((conversation) => conversation.key);
}

export function conversationIdsFor(item: AskCitationInput): Array<{ id: string; key: string }> {
  const metadata = objectValue(item.metadata);
  const conversations: Array<{ id: string; key: string }> = [];
  const chatId = stringValue(metadata.chatId);
  if (chatId) conversations.push({ id: chatId, key: `chat:${item.connectorType}:${chatId}` });

  const threadId =
    stringValue(metadata.threadId) ??
    stringValue(metadata.emailThreadKey) ??
    stringValue(metadata.thread_id);
  if (threadId && (item.sourceType.includes('email') || item.connectorType.includes('gmail'))) {
    conversations.push({ id: threadId, key: `email:${item.connectorType}:${threadId}` });
  }
  return conversations;
}

function isUnreadableAttachmentStub(item: AskCitationInput): boolean {
  if (!attachmentsOf(item).length || item.textSource === 'attachment_ocr') return false;
  if (item.textSource === 'metadata') return true;
  return /\bsent\s+(?:an?\s+[\w-]+|[\w .()[\]-]+\.[a-z0-9]{2,8})\s*$/i.test(item.text);
}

export function collectRelatedDocuments(
  citations: AskCitationInput[],
  candidates: AskCitationInput[],
  cap = 8,
): RelatedDocument[] {
  const wantedKeys = new Set(
    citations.slice(0, 12).flatMap((item) => conversationKeysFor(item)),
  );
  if (!wantedKeys.size) return [];

  const related: RelatedDocument[] = [];
  const seen = new Set<string>();
  for (const item of candidates) {
    if (!conversationKeysFor(item).some((key) => wantedKeys.has(key))) continue;
    if (!isUnreadableAttachmentStub(item)) continue;

    for (const attachment of attachmentsOf(item)) {
      const fileName = attachmentName(attachment);
      if (!fileName) continue;
      const key = `${item.id}:${fileName}`;
      if (seen.has(key)) continue;
      seen.add(key);
      related.push({
        fileName,
        mimeType: attachmentMimeType(attachment),
        sender: senderFor(item),
        date: item.eventTime.toISOString(),
        chatName: chatNameFor(item),
        connectorType: item.connectorType,
        memoryId: item.id,
      });
      if (related.length >= cap) return related;
    }
  }
  return related;
}

export function structuredCitations(citations: AskCitationInput[]): StructuredAskCitation[] {
  return citations.slice(0, 12).map((item, index) => ({
    n: index + 1,
    memoryId: item.id,
    connectorType: item.connectorType,
    chatName: chatNameFor(item),
    sender: senderFor(item),
    date: item.eventTime.toISOString(),
    factuality: factualityLabel(item.factuality),
    snippet: item.text.slice(0, 700),
  }));
}

export function buildAskSynthesisPrompt(
  query: string,
  citations: AskCitationInput[],
  relatedDocuments: RelatedDocument[],
): string {
  const sourceLines = structuredCitations(citations)
    .map((source, index) => {
      const item = citations[index];
      const extra = [
        item.matchMode ? `matchMode=${item.matchMode}` : '',
        item.matchedContactRoles?.length
          ? `matchedRoles=${item.matchedContactRoles.join(',')}`
          : '',
        item.topicCoverage !== undefined ? `topicCoverage=${item.topicCoverage}` : '',
        item.textSource ? `textSource=${item.textSource}` : '',
      ]
        .filter(Boolean)
        .join(' ');
      return [
        `[${source.n}] ${source.connectorType} · ${source.chatName ?? 'unknown'} · from ${
          source.sender ?? 'unknown'
        } · ${source.date} · ${source.factuality} · id=${source.memoryId}`,
        extra,
        source.snippet,
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n\n');

  const documentLines = relatedDocuments
    .map(
      (doc) =>
        `- ${doc.fileName} (${doc.mimeType ?? 'unknown type'}) · from ${
          doc.sender ?? 'unknown'
        } · ${doc.date} · ${doc.chatName ?? 'unknown'} · ${doc.connectorType} · id=${
          doc.memoryId
        }`,
    )
    .join('\n');

  return [
    'Answer using only the cited Botmem memories.',
    'Cite every claim with inline [n] markers referring to the numbered citations.',
    'Do not attribute a topic to a person unless the same citation has a hard_filter match, or it has matched person roles plus non-zero topicCoverage.',
    'If the citations are only fallback or weak related matches, say that no exact person-specific match was found and summarize the weaker evidence.',
    'Never merge facts across different people or senders unless a citation explicitly connects them.',
    'If cited or related memories reference documents whose content is not indexed, explicitly tell the user those documents exist (filename, sender, date, where) and that botmem cannot read their contents. NEVER fabricate document contents.',
    '',
    `Question: ${query}`,
    '',
    'Citations:',
    sourceLines,
    '',
    'Related documents (content not indexed)',
    documentLines || 'None',
  ].join('\n');
}

export async function synthesizeAskAnswer(params: {
  query: string;
  citations: AskCitationInput[];
  relatedDocuments: RelatedDocument[];
  generate: (prompt: string) => Promise<string>;
  onError?: (err: unknown) => void;
}): Promise<{
  answer: string;
  citations: StructuredAskCitation[];
  relatedDocuments: RelatedDocument[];
}> {
  const citations = structuredCitations(params.citations);
  if (!citations.length) {
    return {
      answer: 'No relevant memories found for this question.',
      citations,
      relatedDocuments: params.relatedDocuments,
    };
  }

  try {
    return {
      answer: await params.generate(
        buildAskSynthesisPrompt(params.query, params.citations, params.relatedDocuments),
      ),
      citations,
      relatedDocuments: params.relatedDocuments,
    };
  } catch (err) {
    params.onError?.(err);
    return {
      answer:
        'I found matching memories, but answer generation is unavailable. Use the returned citations.',
      citations,
      relatedDocuments: params.relatedDocuments,
    };
  }
}
