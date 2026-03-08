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
            enum: ['person', 'organization', 'location', 'event', 'product', 'topic', 'pet', 'group', 'device', 'other'],
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
  return `Extract entities from the following text. Return a JSON object with an "entities" array. Each entity has "type" and "value".

Allowed types: person, organization, location, event, product, topic, pet, group, device, other.

Rules:
- Do NOT extract time references, amounts, or metrics -- those are memory metadata, not entities.
- Only use "pet" when the text clearly describes an animal.
- Use "other" only when the entity does not fit any other type.

Text: "${text}"`;
}

export function photoDescriptionPrompt(existingText: string): string {
  return `Describe this photo in detail for a personal memory system. Focus on:
- What is happening in the scene
- Notable objects, landmarks, or features
- The mood and atmosphere
- If people are listed in the metadata, refer to them by name instead of generic terms like "a woman" or "a man". Match names to visible people by position (e.g. left to right) when multiple people are present.

Context from metadata:
${existingText}

Return a concise 2-3 sentence description. Add NEW visual information not already present in the metadata. Do not repeat metadata fields like dates, locations, or camera info — but DO use people's names from the metadata when describing them.`;
}

export function factualityPrompt(
  text: string,
  sourceType: string,
  connectorType: string,
): string {
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
