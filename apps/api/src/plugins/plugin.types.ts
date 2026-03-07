/** Plugin type discriminator */
export type PluginType = 'connector' | 'scorer' | 'lifecycle';

/** Hook names for lifecycle plugins */
export type HookName = 'afterIngest' | 'afterEmbed' | 'afterEnrich' | 'afterSearch';

/** Manifest loaded from manifest.json in plugin directory */
export interface PluginManifest {
  name: string;
  version: string;
  type: PluginType;
  description?: string;
  hooks?: string[];
  entryPoint?: string;
}

/** A lifecycle plugin registers handlers for pipeline hooks */
export interface LifecyclePlugin {
  manifest: PluginManifest;
  hooks: Partial<
    Record<HookName, (data: Record<string, unknown>) => void | Promise<void>>
  >;
}

/** A scorer plugin contributes an additional score to the ranking formula */
export interface ScorerPlugin {
  manifest: PluginManifest;
  score: (
    memory: Record<string, unknown>,
    currentWeights: Record<string, number>,
  ) => number;
}
