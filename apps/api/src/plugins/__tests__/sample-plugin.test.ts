import { describe, it, expect } from 'vitest';
import { readFile } from 'fs/promises';
import { resolve } from 'path';

const pluginDir = resolve(__dirname, '../../../../..', 'plugins/sample-enricher');

describe('sample-enricher plugin', () => {
  describe('manifest.json', () => {
    it('has a valid manifest with required fields', async () => {
      const raw = await readFile(resolve(pluginDir, 'manifest.json'), 'utf-8');
      const manifest = JSON.parse(raw);

      expect(manifest.name).toBe('sample-enricher');
      expect(manifest.version).toBe('1.0.0');
      expect(manifest.type).toBe('lifecycle');
      expect(manifest.hooks).toBeInstanceOf(Array);
      expect(manifest.hooks).toContain('afterEnrich');
    });
  });

  describe('index.js', () => {
    it('exports an afterEnrich function', async () => {
      const plugin = await import(resolve(pluginDir, 'index.js'));
      const mod = plugin.default || plugin;
      expect(typeof mod.afterEnrich).toBe('function');
    });

    it('runs afterEnrich without error on a memory with entities', async () => {
      const plugin = await import(resolve(pluginDir, 'index.js'));
      const mod = plugin.default || plugin;

      const memory = {
        id: '12345678-abcd-efgh-ijkl-123456789abc',
        text: 'Test memory text',
        entities: JSON.stringify([
          { type: 'person', value: 'Alice' },
          { type: 'organization', value: 'Acme Corp' },
        ]),
      };

      // Should not throw
      expect(() => mod.afterEnrich(memory)).not.toThrow();
    });

    it('handles missing entities gracefully', async () => {
      const plugin = await import(resolve(pluginDir, 'index.js'));
      const mod = plugin.default || plugin;

      const memory = {
        id: 'aaaabbbb-cccc-dddd-eeee-ffffffffffff',
        text: 'No entities here',
        entities: null,
      };

      expect(() => mod.afterEnrich(memory)).not.toThrow();
    });

    it('handles undefined entities gracefully', async () => {
      const plugin = await import(resolve(pluginDir, 'index.js'));
      const mod = plugin.default || plugin;

      const memory = {
        id: 'aaaabbbb-cccc-dddd-eeee-ffffffffffff',
        text: 'No entities here',
      };

      expect(() => mod.afterEnrich(memory)).not.toThrow();
    });
  });
});
