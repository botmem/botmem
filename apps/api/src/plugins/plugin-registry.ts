import { Injectable, Logger } from '@nestjs/common';
import type { HookName, LifecyclePlugin, ScorerPlugin } from './plugin.types';

@Injectable()
export class PluginRegistry {
  private readonly logger = new Logger(PluginRegistry.name);
  private readonly lifecyclePlugins: LifecyclePlugin[] = [];
  private readonly scorerPlugins: ScorerPlugin[] = [];

  registerLifecycle(plugin: LifecyclePlugin): void {
    this.lifecyclePlugins.push(plugin);
    this.logger.log(
      `Registered lifecycle plugin: ${plugin.manifest.name} (hooks: ${Object.keys(plugin.hooks).join(', ')})`,
    );
  }

  registerScorer(plugin: ScorerPlugin): void {
    this.scorerPlugins.push(plugin);
    this.logger.log(`Registered scorer plugin: ${plugin.manifest.name}`);
  }

  async fireHook(
    hook: HookName,
    data: Record<string, unknown>,
  ): Promise<void> {
    const handlers = this.lifecyclePlugins.filter((p) => p.hooks[hook]);
    if (handlers.length === 0) return;

    const frozenData = Object.freeze({ ...data });

    const results = await Promise.allSettled(
      handlers.map((p) => {
        try {
          return Promise.resolve(p.hooks[hook]!(frozenData));
        } catch (err) {
          return Promise.reject(err);
        }
      }),
    );

    for (const result of results) {
      if (result.status === 'rejected') {
        this.logger.warn(
          `Hook "${hook}" handler failed: ${result.reason?.message ?? result.reason}`,
        );
      }
    }
  }

  getScorers(): ScorerPlugin[] {
    return [...this.scorerPlugins];
  }

  getLifecyclePlugins(): LifecyclePlugin[] {
    return [...this.lifecyclePlugins];
  }
}
