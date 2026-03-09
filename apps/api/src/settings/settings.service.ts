import { Injectable, OnModuleInit } from '@nestjs/common';
import { DbService } from '../db/db.service';
import { settings } from '../db/schema';

type SettingChangeListener = (key: string, value: string) => void;

const DEFAULTS: Record<string, string> = {
  sync_concurrency: '2',
  embed_concurrency: '12',
  enrich_concurrency: '6',
  file_concurrency: '4',
  sync_debug_limit: '0',
};

@Injectable()
export class SettingsService implements OnModuleInit {
  private listeners: SettingChangeListener[] = [];
  private cache: Record<string, string> = { ...DEFAULTS };

  constructor(private dbService: DbService) {}

  async onModuleInit() {
    // Seed all missing defaults in one query, then load all into cache
    const defaultValues = Object.entries(DEFAULTS).map(([key, value]) => ({ key, value }));
    await this.dbService.db.insert(settings).values(defaultValues).onConflictDoNothing();
    const rows = await this.dbService.db.select().from(settings);
    for (const row of rows) {
      this.cache[row.key] = row.value;
    }
  }

  async get(key: string): Promise<string> {
    return this.cache[key] ?? DEFAULTS[key] ?? '';
  }

  async getAll(): Promise<Record<string, string>> {
    return { ...this.cache };
  }

  async set(key: string, value: string): Promise<void> {
    await this.dbService.db
      .insert(settings)
      .values({ key, value })
      .onConflictDoUpdate({ target: settings.key, set: { value } });
    this.cache[key] = value;
    for (const listener of this.listeners) {
      listener(key, value);
    }
  }

  onChange(listener: SettingChangeListener): void {
    this.listeners.push(listener);
  }
}
