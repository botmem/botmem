import { Injectable, OnModuleInit } from '@nestjs/common';
import { eq } from 'drizzle-orm';
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

  constructor(private dbService: DbService) {}

  async onModuleInit() {
    // Seed defaults for any missing settings
    for (const [key, value] of Object.entries(DEFAULTS)) {
      const [existing] = await this.dbService.db.select().from(settings).where(eq(settings.key, key));
      if (!existing) {
        await this.dbService.db.insert(settings).values({ key, value });
      }
    }
  }

  async get(key: string): Promise<string> {
    const [row] = await this.dbService.db.select().from(settings).where(eq(settings.key, key));
    return row?.value ?? DEFAULTS[key] ?? '';
  }

  async getAll(): Promise<Record<string, string>> {
    const rows = await this.dbService.db.select().from(settings);
    const result: Record<string, string> = { ...DEFAULTS };
    for (const row of rows) {
      result[row.key] = row.value;
    }
    return result;
  }

  async set(key: string, value: string): Promise<void> {
    await this.dbService.db.insert(settings).values({ key, value })
      .onConflictDoUpdate({ target: settings.key, set: { value } });
    for (const listener of this.listeners) {
      listener(key, value);
    }
  }

  onChange(listener: SettingChangeListener): void {
    this.listeners.push(listener);
  }
}
