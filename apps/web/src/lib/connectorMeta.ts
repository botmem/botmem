import { CONNECTOR_COLORS } from '@botmem/shared';

export { CONNECTOR_COLORS };

export const CONNECTOR_ICONS: Record<string, string> = {
  gmail: 'G',
  whatsapp: 'W',
  slack: '#',
  imessage: 'i',
  'photos-immich': 'Ph',
  photos: 'Ph',
  locations: 'Lo',
};

export const CONNECTOR_LABELS: Record<string, string> = {
  gmail: 'Gmail',
  whatsapp: 'WhatsApp',
  slack: 'Slack',
  imessage: 'iMessage',
  photos: 'Photos',
  locations: 'Locations',
};

export function getConnectorIcon(type: string): string {
  return CONNECTOR_ICONS[type] ?? '?';
}

export function getConnectorColor(type: string): string {
  return CONNECTOR_COLORS[type] ?? '#999';
}
