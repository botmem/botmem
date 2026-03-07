import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PluginRegistry } from '../plugin-registry';
import type { LifecyclePlugin, ScorerPlugin } from '../plugin.types';

describe('PluginRegistry', () => {
  let registry: PluginRegistry;

  beforeEach(() => {
    registry = new PluginRegistry();
  });

  describe('registerLifecycle', () => {
    it('stores a lifecycle plugin and its hooks are callable via fireHook', async () => {
      const handler = vi.fn();
      const plugin: LifecyclePlugin = {
        manifest: { name: 'test-lc', version: '1.0.0', type: 'lifecycle' },
        hooks: { afterEnrich: handler },
      };

      registry.registerLifecycle(plugin);

      await registry.fireHook('afterEnrich', { memoryId: '123' });
      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe('registerScorer', () => {
    it('stores a scorer plugin retrievable via getScorers', () => {
      const plugin: ScorerPlugin = {
        manifest: { name: 'test-scorer', version: '1.0.0', type: 'scorer' },
        score: () => 0.5,
      };

      registry.registerScorer(plugin);

      const scorers = registry.getScorers();
      expect(scorers).toHaveLength(1);
      expect(scorers[0].manifest.name).toBe('test-scorer');
    });
  });

  describe('fireHook', () => {
    it('calls all lifecycle plugins that registered the given hook', async () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      registry.registerLifecycle({
        manifest: { name: 'p1', version: '1.0.0', type: 'lifecycle' },
        hooks: { afterEnrich: handler1 },
      });
      registry.registerLifecycle({
        manifest: { name: 'p2', version: '1.0.0', type: 'lifecycle' },
        hooks: { afterEnrich: handler2 },
      });

      await registry.fireHook('afterEnrich', { id: 'abc' });

      expect(handler1).toHaveBeenCalledTimes(1);
      expect(handler2).toHaveBeenCalledTimes(1);
    });

    it('passes a frozen shallow copy of the data so plugins cannot mutate pipeline state', async () => {
      const original = { memoryId: '123', score: 0.9 };

      registry.registerLifecycle({
        manifest: { name: 'mutator', version: '1.0.0', type: 'lifecycle' },
        hooks: {
          afterEnrich: (data) => {
            // Attempting to mutate frozen data should throw
            expect(() => {
              (data as any).memoryId = 'hacked';
            }).toThrow();
          },
        },
      });

      await registry.fireHook('afterEnrich', original);

      // Original data remains unchanged
      expect(original.memoryId).toBe('123');
    });

    it('catches a throwing handler and still executes other handlers', async () => {
      const goodHandler = vi.fn();

      registry.registerLifecycle({
        manifest: { name: 'bad', version: '1.0.0', type: 'lifecycle' },
        hooks: {
          afterEnrich: () => {
            throw new Error('plugin crashed');
          },
        },
      });
      registry.registerLifecycle({
        manifest: { name: 'good', version: '1.0.0', type: 'lifecycle' },
        hooks: { afterEnrich: goodHandler },
      });

      // Should not throw
      await registry.fireHook('afterEnrich', { id: '1' });

      // Good handler still executed despite bad handler throwing
      expect(goodHandler).toHaveBeenCalledTimes(1);
    });

    it('completes without error when no handlers are registered for a hook', async () => {
      await expect(
        registry.fireHook('afterSearch', { query: 'test' }),
      ).resolves.toBeUndefined();
    });
  });

  describe('getScorers', () => {
    it('returns a copy of the scorer array (mutations do not affect registry)', () => {
      const plugin: ScorerPlugin = {
        manifest: { name: 'scorer1', version: '1.0.0', type: 'scorer' },
        score: () => 0.8,
      };

      registry.registerScorer(plugin);

      const scorers1 = registry.getScorers();
      scorers1.pop(); // mutate the returned array

      const scorers2 = registry.getScorers();
      expect(scorers2).toHaveLength(1); // registry unaffected
    });
  });

  describe('getLifecyclePlugins', () => {
    it('returns a shallow copy of lifecycle plugins', () => {
      registry.registerLifecycle({
        manifest: { name: 'lc1', version: '1.0.0', type: 'lifecycle' },
        hooks: { afterIngest: vi.fn() },
      });

      const plugins = registry.getLifecyclePlugins();
      expect(plugins).toHaveLength(1);

      plugins.pop();
      expect(registry.getLifecyclePlugins()).toHaveLength(1);
    });
  });
});
