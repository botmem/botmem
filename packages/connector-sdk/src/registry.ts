import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import { BaseConnector } from './base.js';
import type { ConnectorManifest } from './types.js';

export class ConnectorRegistry {
  private connectors = new Map<string, BaseConnector>();

  register(factory: () => BaseConnector): void {
    const connector = factory();
    this.connectors.set(connector.manifest.id, connector);
  }

  get(id: string): BaseConnector {
    const connector = this.connectors.get(id);
    if (!connector) throw new Error(`Connector "${id}" not found`);
    return connector;
  }

  has(id: string): boolean {
    return this.connectors.has(id);
  }

  list(): ConnectorManifest[] {
    return Array.from(this.connectors.values()).map((c) => c.manifest);
  }

  async loadFromDirectory(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // Directory doesn't exist, skip
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const pkgPath = join(dir, entry.name, 'package.json');
      try {
        const pkgJson = await readFile(pkgPath, 'utf-8');
        const pkg = JSON.parse(pkgJson);
        if (!pkg.botmem?.connector) continue;

        const mod = await import(join(dir, entry.name));
        const factory = mod.default || mod.createConnector;
        if (typeof factory === 'function') {
          this.register(factory);
        }
      } catch {
        // Skip packages that fail to load
      }
    }
  }
}
