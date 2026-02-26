import { Injectable, OnModuleInit } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { settings } from '../db/schema';

type SettingChangeListener = (key: string, value: string) => void;

const DEFAULTS: Record<string, string> = {
  sync_concurrency: '2',
  embed_concurrency: '4',
  enrich_concurrency: '2',
};

@Injectable()
export class SettingsService implements OnModuleInit {
  private listeners: SettingChangeListener[] = [];

  constructor(private dbService: DbService) {}

  onModuleInit() {
    // Seed defaults for any missing settings
    for (const [key, value] of Object.entries(DEFAULTS)) {
      const existing = this.dbService.db.select().from(settings).where(eq(settings.key, key)).get();
      if (!existing) {
        this.dbService.db.insert(settings).values({ key, value }).run();
      }
    }
  }

  get(key: string): string {
    const row = this.dbService.db.select().from(settings).where(eq(settings.key, key)).get();
    return row?.value ?? DEFAULTS[key] ?? '';
  }

  getAll(): Record<string, string> {
    const rows = this.dbService.db.select().from(settings).all();
    const result: Record<string, string> = { ...DEFAULTS };
    for (const row of rows) {
      result[row.key] = row.value;
    }
    return result;
  }

  set(key: string, value: string): void {
    this.dbService.db.insert(settings).values({ key, value })
      .onConflictDoUpdate({ target: settings.key, set: { value } })
      .run();
    for (const listener of this.listeners) {
      listener(key, value);
    }
  }

  onChange(listener: SettingChangeListener): void {
    this.listeners.push(listener);
  }
}
