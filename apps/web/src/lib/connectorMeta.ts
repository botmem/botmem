import { CONNECTOR_COLORS } from '@botmem/shared';

export { CONNECTOR_COLORS };

export const CONNECTOR_ICONS: Record<string, string> = {
  gmail: '\u2709',
  whatsapp: '\uD83D\uDCAC',
  slack: '#',
  imessage: '\u25EF',
  photos: '\uD83D\uDCF7',
  locations: '\uD83D\uDCCD',
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
  return CONNECTOR_ICONS[type] ?? '\u26A1';
}

export function getConnectorColor(type: string): string {
  return CONNECTOR_COLORS[type] ?? '#999';
}
