export function entityExtractionPrompt(text: string): string {
  return `Extract entities from this text. Return ONLY a JSON array of objects with {type, value, confidence}.
Types: person, location, time, organization, amount, product, event, metric.
Do not include any explanation, only the JSON array.

Text: "${text}"`;
}

export function photoDescriptionPrompt(existingText: string): string {
  return `Describe this photo in detail for a personal memory system. Focus on:
- What is happening in the scene
- Notable objects, landmarks, or features
- The mood and atmosphere

Context from metadata:
${existingText}

Return a concise 2-3 sentence description. Add NEW visual information not already present in the metadata. Do not repeat metadata fields.`;
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
