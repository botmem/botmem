const CANONICAL_CONNECTOR_TYPES: Record<string, string> = {
  imessage: 'apple',
  'photos-immich': 'photos',
};

export function canonicalConnectorType(connectorType: string): string {
  return CANONICAL_CONNECTOR_TYPES[connectorType] ?? connectorType;
}
