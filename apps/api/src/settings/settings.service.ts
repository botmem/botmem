import { Injectable, OnModuleInit } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DbService, type BotmemDb } from '../db/db.service';
import { settings } from '../db/schema';

type SettingChangeListener = (key: string, value: string) => void;
export const SYSTEM_SETTINGS_USER_ID = '__system__';

const DEFAULTS: Record<string, string> = {
  sync_concurrency: '8',
  embed_concurrency: '64',
  enrich_concurrency: '1000',
  clean_concurrency: '64',
  file_concurrency: '8',
  sync_debug_limit: '0',
};

@Injectable()
export class SettingsService implements OnModuleInit {
  private listeners: SettingChangeListener[] = [];
  private cacheByUser = new Map<string, Record<string, string>>([
    [SYSTEM_SETTINGS_USER_ID, { ...DEFAULTS }],
  ]);

  constructor(private dbService: DbService) {}

  async onModuleInit() {
    // Seed all missing defaults in one query, then load all into cache
    const defaultValues = Object.entries(DEFAULTS).map(([key, value]) => ({
      userId: SYSTEM_SETTINGS_USER_ID,
      key,
      value,
    }));
    await this.dbService.systemDb((db) =>
      db.insert(settings).values(defaultValues).onConflictDoNothing(),
    );
    const rows = await this.dbService.systemDb((db) =>
      db.select().from(settings).where(eq(settings.userId, SYSTEM_SETTINGS_USER_ID)),
    );
    const systemCache = { ...DEFAULTS };
    for (const row of rows) {
      systemCache[row.key] = row.value;
    }
    this.cacheByUser.set(SYSTEM_SETTINGS_USER_ID, systemCache);
  }

  async get(key: string, userId = SYSTEM_SETTINGS_USER_ID): Promise<string> {
    if (!this.cacheByUser.has(userId)) await this.getAll(userId);
    return this.cacheFor(userId)[key] ?? DEFAULTS[key] ?? '';
  }

  async getAll(userId = SYSTEM_SETTINGS_USER_ID): Promise<Record<string, string>> {
    if (!this.cacheByUser.has(userId)) {
      const rows = await this.scopedDb(userId, (db) =>
        db.select().from(settings).where(eq(settings.userId, userId)),
      );
      this.cacheByUser.set(userId, {
        ...DEFAULTS,
        ...Object.fromEntries(rows.map((r) => [r.key, r.value])),
      });
    }
    return { ...this.cacheFor(userId) };
  }

  async set(userId: string, key: string, value: string): Promise<void> {
    await this.scopedDb(userId, (db) =>
      db
        .insert(settings)
        .values({ userId, key, value })
        .onConflictDoUpdate({ target: [settings.userId, settings.key], set: { value } }),
    );
    this.cacheFor(userId)[key] = value;
    if (userId === SYSTEM_SETTINGS_USER_ID) {
      for (const listener of this.listeners) {
        listener(key, value);
      }
    }
  }

  onChange(listener: SettingChangeListener): void {
    this.listeners.push(listener);
  }

  private cacheFor(userId: string): Record<string, string> {
    let cache = this.cacheByUser.get(userId);
    if (!cache) {
      cache = { ...DEFAULTS };
      this.cacheByUser.set(userId, cache);
    }
    return cache;
  }

  private scopedDb<T>(userId: string, fn: (db: BotmemDb) => Promise<T>): Promise<T> {
    return userId === SYSTEM_SETTINGS_USER_ID
      ? this.dbService.systemDb(fn)
      : this.dbService.userDb(userId, fn);
  }
}
