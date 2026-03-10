import { describe, it, expect } from 'vitest';
import { getConnectorIcon, getConnectorColor, CONNECTOR_ICONS, CONNECTOR_LABELS } from '../connectorMeta';

describe('connectorMeta', () => {
  describe('getConnectorIcon', () => {
    it('returns icon for known connector', () => {
      expect(getConnectorIcon('gmail')).toBe('G');
      expect(getConnectorIcon('whatsapp')).toBe('W');
      expect(getConnectorIcon('slack')).toBe('#');
    });

    it('returns ? for unknown connector', () => {
      expect(getConnectorIcon('unknown')).toBe('?');
    });
  });

  describe('getConnectorColor', () => {
    it('returns color for known connector', () => {
      expect(getConnectorColor('gmail')).toMatch(/^#/);
    });

    it('returns fallback for unknown connector', () => {
      expect(getConnectorColor('unknown')).toBe('#999');
    });
  });

  describe('exports', () => {
    it('exports CONNECTOR_ICONS', () => {
      expect(CONNECTOR_ICONS).toBeDefined();
      expect(typeof CONNECTOR_ICONS.gmail).toBe('string');
    });

    it('exports CONNECTOR_LABELS', () => {
      expect(CONNECTOR_LABELS).toBeDefined();
      expect(CONNECTOR_LABELS.gmail).toBe('Gmail');
    });
  });
});
