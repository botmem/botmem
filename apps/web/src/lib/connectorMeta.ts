import { CONNECTOR_COLORS, getConnectorColor } from '@botmem/shared';

export { CONNECTOR_COLORS, getConnectorColor };

export const CONNECTOR_ICONS: Record<string, string> = {
  gmail: 'G',
  whatsapp: 'W',
  slack: '#',
  apple: 'A',
  imessage: 'i',
  'photos-immich': 'Ph',
  photos: 'Ph',
  locations: 'Lo',
  telegram: 'Tg',
  outlook: 'O',
};

export const CONNECTOR_LABELS: Record<string, string> = {
  gmail: 'Gmail',
  whatsapp: 'WhatsApp',
  slack: 'Slack',
  apple: 'Apple',
  imessage: 'iMessage',
  photos: 'Photos',
  locations: 'Locations',
  telegram: 'Telegram',
  outlook: 'Outlook',
};

export function getConnectorIcon(type: string): string {
  return CONNECTOR_ICONS[type] ?? '?';
}
