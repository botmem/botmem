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

export function entityExtractionPrompt(text: string): string {
  return `Extract named entities from the following text. Return a JSON object with an "entities" array. Each entity has "type" and "value".

Allowed types and examples:
- person: named people ("John Smith", "Dr. Lee", "Mom")
- group: chat groups, channels, mailing lists ("Family Group", "#engineering", "Project Team Chat")
- organization: companies, institutions ("Google", "UN", "Stanford University")
- location: places, addresses, regions ("New York", "Building 42", "Japan")
- date: named temporal references ("March 2024", "next Tuesday", "Q3") — NOT relative words like "yesterday" or "now"
- event: named occurrences ("board meeting", "product launch", "wedding")
- product: named products, software, devices ("iPhone 15", "Slack", "MacBook")
- concept: topics, ideas, methodologies ("machine learning", "agile methodology", "budget")
- quantity: amounts, measurements, percentages ("$500", "3 million users", "50%")
- language: human or programming languages ("English", "Python", "Arabic")
- other: only when the entity clearly does not fit any other type

Rules:
- Extract ONLY named entities — specific people, places, things, or concepts.
- Do NOT extract: greetings ("hello", "thanks", "bye"), pronouns ("I", "you", "he", "she"), generic terms ("ok", "yes", "no", "sure", "please"), single characters, or bare URLs.
- Do NOT extract actions, verbs, or adjectives as entities.
- Extract at most 30 entities. Focus on the most important and specific ones.
- Use "other" sparingly — most entities should fit one of the specific types above.

Text: "${text}"`;
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
  return `Classify this memory's factuality. Consider the source and content.
Source: ${sourceType} from ${connectorType}
Text: "${text}"

Return ONLY a JSON object: {"label": "FACT"|"UNVERIFIED"|"FICTION", "confidence": 0-1, "rationale": "..."}

Rules:
- Official confirmations (airline, billing, calendar invites) → FACT with high confidence
- Personal messages with plans/opinions → UNVERIFIED
- Claims that seem unreliable or contradicted → FICTION
Do not include any explanation, only the JSON object.`;
}
