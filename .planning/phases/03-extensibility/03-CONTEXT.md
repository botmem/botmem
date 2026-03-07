# Phase 3: Extensibility - Context

**Gathered:** 2026-03-07
**Status:** Ready for planning

<domain>
## Phase Boundary

Add a plugin system that supports three plugin types (connector, scorer, lifecycle hook) loaded from the plugins directory. Lifecycle hooks fire on memory events (afterIngest, afterEmbed, afterEnrich, afterSearch). Plugins are plain objects with a manifest, not NestJS providers. A sample enricher plugin demonstrates the interface. No plugin marketplace, hot-reload, or sandboxing.

</domain>

<decisions>
## Implementation Decisions

### Plugin types
- Three plugin types: `connector`, `scorer`, `lifecycle`
- Connector plugins already work via `ConnectorRegistry.loadFromDirectory()` — extend this pattern
- Scorer plugins provide a custom scoring function that can contribute to the final score
- Lifecycle hook plugins subscribe to memory events and receive the memory object

### Plugin loading
- Plugins are loaded from the `PLUGINS_DIR` directory (default: `./plugins`)
- Each plugin is a directory with a `manifest.json` and an entry point (e.g., `index.js` or `index.ts`)
- Manifest fields: `name`, `version`, `type` (connector | scorer | lifecycle), `description`, `hooks` (for lifecycle type)
- Plugins are plain objects exported from the entry point — NOT NestJS providers
- Loading happens at startup via `PluginsService.loadAll()` which already exists and loads connectors

### Lifecycle hooks
- Four hook points: `afterIngest`, `afterEmbed`, `afterEnrich`, `afterSearch`
- Hook handlers receive the memory object (read-only) and can log, track, or enrich externally
- Hooks are fire-and-forget — they should not block the pipeline
- A hook that throws is caught and logged, never crashes the pipeline
- Multiple plugins can subscribe to the same hook — all are called

### Sample enricher plugin
- A working sample plugin in `plugins/sample-enricher/` that demonstrates the lifecycle hook interface
- The sample hooks into `afterEnrich` and logs the memory's entities to demonstrate the pattern
- The sample includes a `manifest.json`, `index.js`, and a `README.md` explaining the plugin API
- This serves as documentation-by-example — developers copy and modify it

### Claude's Discretion
- Exact manifest schema fields beyond the required ones
- How to wire hook calls into the existing processors (SyncProcessor, EmbedProcessor, EnrichProcessor, search method)
- Whether to use a central event bus or direct function calls for hooks
- Plugin validation and error reporting
- Whether scorer plugins integrate with `computeWeights()` or replace it

</decisions>

<specifics>
## Specific Ideas

- The existing `PluginsService` already loads connectors from the plugins directory — extend this to load all three plugin types
- `ConnectorRegistry.loadFromDirectory()` pattern can be generalized to a `PluginRegistry` that handles all types
- PROJECT.md states: "Plugin/extension system (stub exists)" — this phase fulfills that active requirement
- REQUIREMENTS.md: EXT-03 says "Plugins are plain objects with a manifest, not NestJS providers — loaded from plugins directory"

</specifics>

<code_context>
## Existing Code Insights

### Reusable Assets
- `PluginsService` (`apps/api/src/plugins/plugins.service.ts`): Already loads connectors at startup — extend to handle scorer and lifecycle types
- `PluginsModule` (`apps/api/src/plugins/plugins.module.ts`): NestJS module that calls `loadAll()` on init
- `ConnectorRegistry.loadFromDirectory()`: Pattern for loading external plugins from filesystem
- `ConfigService.pluginsDir`: Already configured, defaults to `./plugins`

### Established Patterns
- Connectors are loaded via dynamic `import()` from the plugins directory
- Connectors use a factory function pattern: `mod.default || mod.createConnector`
- Error handling: individual plugin failures are warned but don't crash startup
- Processors (SyncProcessor, EmbedProcessor, EnrichProcessor) are the pipeline stages where hooks would fire

### Integration Points
- `PluginsService.loadAll()`: Add loading for scorer and lifecycle plugin types
- `EmbedProcessor`: Fire `afterIngest` and `afterEmbed` hooks
- `EnrichProcessor`: Fire `afterEnrich` hooks
- `MemoryService.search()`: Fire `afterSearch` hooks
- `plugins/` directory: Create sample-enricher plugin

</code_context>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 03-extensibility*
*Context gathered: 2026-03-07*
