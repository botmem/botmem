export const ENTITY_FORMAT_SCHEMA = {
  type: 'object',
  properties: {
    entities: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: [
              'person',
              'group',
              'organization',
              'location',
              'date',
              'event',
              'product',
              'concept',
              'quantity',
              'language',
              'other',
            ],
          },
          value: { type: 'string' },
        },
        required: ['type', 'value'],
      },
    },
  },
  required: ['entities'],
};

export const ENRICHMENT_FORMAT_SCHEMA = {
  type: 'object',
  properties: {
    entities: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: [
              'person',
              'group',
              'organization',
              'location',
              'date',
              'event',
              'product',
              'concept',
              'quantity',
              'language',
              'other',
            ],
          },
          value: { type: 'string' },
        },
        required: ['type', 'value'],
      },
    },
    factuality: {
      type: 'object',
      properties: {
        label: { type: 'string', enum: ['FACT', 'UNVERIFIED', 'FICTION'] },
        confidence: { type: 'number' },
        rationale: { type: 'string' },
      },
      required: ['label', 'confidence', 'rationale'],
    },
  },
  required: ['entities', 'factuality'],
};

export function entityExtractionPrompt(
  text: string,
  sourceType?: string,
  connectorType?: string,
): string {
  // Truncate input to reduce token cost — entities rarely appear past 3000 chars
  const truncated = text.length > 3000 ? text.slice(0, 3000) : text;

  const contextLine =
    sourceType || connectorType
      ? `\nSource: ${sourceType || 'unknown'} from ${connectorType || 'unknown'} connector.\n`
      : '';

  return `Extract named entities from the following text. Return JSON: {"entities":[{"type":"...","value":"..."}]}
Types: person, group, organization, location, date, event, product, concept, quantity, language, other.
Max 20 entities. Only extract specific, named entities — no pronouns, greetings, or generic words.
${contextLine}
Examples:
- Email: "Meeting with Sarah at Google HQ on Friday" → [{"type":"person","value":"Sarah"},{"type":"organization","value":"Google"},{"type":"location","value":"Google HQ"},{"type":"date","value":"Friday"}]
- Chat: "Did you see the new iPhone 16?" → [{"type":"product","value":"iPhone 16"}]
- Photo metadata: "Location: Paris, France. People: John, Maria" → [{"type":"location","value":"Paris, France"},{"type":"person","value":"John"},{"type":"person","value":"Maria"}]

Text: "${truncated}"`;
}

/**
 * Combined enrichment prompt: extracts entities AND classifies factuality in one LLM call.
 * Used for email source types where factuality classification adds value.
 */
export function enrichmentPrompt(text: string, sourceType: string, connectorType: string): string {
  const truncated = text.length > 3000 ? text.slice(0, 3000) : text;
  return `Analyze this ${sourceType} from ${connectorType}. Extract entities and classify factuality. Return JSON only.

Format: {"entities":[{"type":"person|group|organization|location|date|event|product|concept|quantity|language|other","value":"..."}],"factuality":{"label":"FACT|UNVERIFIED|FICTION","confidence":0.0-1.0,"rationale":"brief reason"}}

Rules:
- Max 20 entities. Only named/specific entities.
- FACT: verifiable claims corroborated by context. UNVERIFIED: single-source, unconfirmed. FICTION: contradicted or clearly false.

Examples:
- "Meeting with Sarah at Google HQ on Friday" → entities: Sarah (person), Google (org), Google HQ (location), Friday (date). factuality: UNVERIFIED, 0.5, "single-source meeting mention"
- "Revenue grew 15% in Q3 2025" → entities: Q3 2025 (date). factuality: UNVERIFIED, 0.6, "financial claim, single source"

Text: "${truncated}"`;
}

export function photoDescriptionPrompt(existingText: string): string {
  return `You are describing a photo for a personal memory system. Be STRICTLY factual — only describe what you can actually see.

RULES:
- Describe ONLY what is visually present: people, objects, setting, actions.
- If people are listed in the metadata, use those names. NEVER invent names, pet names, or nicknames not in the metadata.
- Do NOT invent details you cannot see (breed of animal, relationship between people, names of objects, etc.).
- Do NOT guess emotions, backstories, or narrative context.
- If you cannot clearly identify something, say so or omit it.
- Do NOT repeat metadata fields (dates, locations, camera info).

Context from metadata:
${existingText}

Return 2-3 factual sentences describing what is visible in the photo.`;
}

export function factualityPrompt(text: string, sourceType: string, connectorType: string): string {
  // Truncate input to reduce token cost
  const truncated = text.length > 2000 ? text.slice(0, 2000) : text;
  return `Classify factuality. Return ONLY JSON: {"label":"FACT"|"UNVERIFIED"|"FICTION","confidence":0-1,"rationale":"..."}
Source: ${sourceType}/${connectorType}
Text: "${truncated}"`;
}
