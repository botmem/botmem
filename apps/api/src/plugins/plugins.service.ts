import { Injectable, Logger } from '@nestjs/common';
import { resolve, join } from 'path';
import { readdir, readFile } from 'fs/promises';
import { eq } from 'drizzle-orm';
import { ConnectorsService } from '../connectors/connectors.service';
import { ConfigService } from '../config/config.service';
import { EventsService } from '../events/events.service';
import { DbService } from '../db/db.service';
import { accounts } from '../db/schema';
import { PluginRegistry } from './plugin-registry';
import type { PluginManifest, HookName } from './plugin.types';

const VALID_HOOKS: HookName[] = ['afterIngest', 'afterEmbed', 'afterEnrich', 'afterSearch'];

@Injectable()
export class PluginsService {
  private readonly logger = new Logger(PluginsService.name);

  constructor(
    private connectors: ConnectorsService,
    private config: ConfigService,
    private registry: PluginRegistry,
    private events: EventsService,
    private dbService: DbService,
  ) {}

  async loadAll() {
    // Register built-in connectors
    this.logger.log('Registering built-in connectors...');
    await this.loadBuiltin('@botmem/connector-photos-immich');
    await this.loadBuiltin('@botmem/connector-gmail');
    await this.loadBuiltin('@botmem/connector-slack');
    await this.loadBuiltin('@botmem/connector-whatsapp');
    await this.loadBuiltin('@botmem/connector-imessage');
    await this.loadBuiltin('@botmem/connector-locations');

    // Load external plugins (connectors from directory)
    const dir = resolve(this.config.pluginsDir);
    this.logger.log(`Loading external connectors from ${dir}`);
    await this.connectors.registry.loadFromDirectory(dir);

    this.logger.log(`Loaded ${this.connectors.list().length} total connectors`);

    // Wire up WhatsApp decrypt-failure and session-expired notifications
    this.setupDecryptFailureListener();
    this.setupSessionExpiredListener();

    // Load lifecycle and scorer plugins from manifest.json files
    await this.loadManifestPlugins(dir);
  }

  private async loadManifestPlugins(dir: string) {
    let entries: Awaited<ReturnType<typeof readdir>>;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      this.logger.warn(`Could not read plugins directory: ${dir}`);
      return;
    }

    let lifecycleCount = 0;
    let scorerCount = 0;

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const pluginDir = join(dir, entry.name);
      const manifestPath = join(pluginDir, 'manifest.json');

      try {
        const raw = await readFile(manifestPath, 'utf-8');
        const manifest: PluginManifest = JSON.parse(raw);

        if (manifest.type === 'connector') {
          // Already handled by ConnectorRegistry.loadFromDirectory
          continue;
        }

        const entryPoint = manifest.entryPoint || 'index.js';
        const entryPath = join(pluginDir, entryPoint);

        // Guard against path traversal in entryPoint (e.g. "../../etc/malicious")
        if (!resolve(entryPath).startsWith(resolve(pluginDir))) {
          this.logger.warn(
            `Plugin "${entry.name}" has an entryPoint that escapes its directory — skipping`,
          );
          continue;
        }

        const mod = await this._importPlugin(entryPath);
        const plugin = mod.default || mod;

        if (manifest.type === 'lifecycle') {
          const hooks: Record<string, (...args: unknown[]) => unknown> = {};
          const hookNames = manifest.hooks || [];
          for (const hookName of hookNames) {
            if (
              VALID_HOOKS.includes(hookName as HookName) &&
              typeof plugin[hookName] === 'function'
            ) {
              hooks[hookName] = plugin[hookName].bind(plugin);
            }
          }
          this.registry.registerLifecycle({ manifest, hooks });
          lifecycleCount++;
        } else if (manifest.type === 'scorer') {
          if (typeof plugin.score !== 'function') {
            this.logger.warn(`Scorer plugin "${manifest.name}" has no score function`);
            continue;
          }
          this.registry.registerScorer({
            manifest,
            score: plugin.score.bind(plugin),
          });
          scorerCount++;
        }
      } catch (err: unknown) {
        this.logger.warn(
          `Could not load plugin from ${entry.name}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (lifecycleCount > 0 || scorerCount > 0) {
      this.logger.log(`Loaded ${lifecycleCount} lifecycle and ${scorerCount} scorer plugins`);
    }
  }

  private setupDecryptFailureListener() {
    try {
      const wa = this.connectors.get('whatsapp');
      wa.on('decrypt-failure', async ({ message }: { message: string }) => {
        this.logger.warn(message);
        // Update all WhatsApp accounts with the error
        const waAccounts = await this.dbService.db
          .select({ id: accounts.id })
          .from(accounts)
          .where(eq(accounts.connectorType, 'whatsapp'));
        for (const acc of waAccounts) {
          await this.dbService.db
            .update(accounts)
            .set({ lastError: message, updatedAt: new Date() })
            .where(eq(accounts.id, acc.id));
        }
        // Broadcast to frontend
        this.events.emitToChannel('notifications', 'connector:warning', {
          connectorType: 'whatsapp',
          message,
          action: 'reauth',
        });
      });
    } catch {
      // WhatsApp connector not loaded — skip
    }
  }

  private setupSessionExpiredListener() {
    try {
      const wa = this.connectors.get('whatsapp');
      wa.on('session-expired', async ({ message }: { message: string; code: number }) => {
        this.logger.warn(`WhatsApp session expired: ${message}`);
        const waAccounts = await this.dbService.db
          .select({ id: accounts.id })
          .from(accounts)
          .where(eq(accounts.connectorType, 'whatsapp'));
        for (const acc of waAccounts) {
          await this.dbService.db
            .update(accounts)
            .set({ status: 'disconnected', lastError: message, updatedAt: new Date() })
            .where(eq(accounts.id, acc.id));
        }
        this.events.emitToChannel('notifications', 'connector:warning', {
          connectorType: 'whatsapp',
          message: `WhatsApp: ${message}. Please reconnect.`,
          action: 'reauth',
        });
      });
    } catch {
      // WhatsApp connector not loaded — skip
    }
  }

  /** Overridable for testing */
  async _importPlugin(path: string): Promise<Record<string, unknown>> {
    return import(path);
  }

  private async loadBuiltin(packageName: string) {
    try {
      const mod = await import(packageName);
      const factory = mod.default || mod.createConnector;
      if (typeof factory === 'function') {
        this.connectors.register(factory);
        this.logger.log(`Registered ${packageName}`);
      }
    } catch (err: unknown) {
      this.logger.warn(
        `Could not load ${packageName}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
