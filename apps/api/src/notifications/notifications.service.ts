import { Injectable } from '@nestjs/common';
import { eq, and, desc } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { DbService } from '../db/db.service';
import { notifications } from '../db/schema';
import { EventsService } from '../events/events.service';

@Injectable()
export class NotificationsService {
  constructor(
    private db: DbService,
    private events: EventsService,
  ) {}

  async create(
    userId: string,
    message: string,
    level: 'info' | 'warn' | 'error' | 'success' = 'info',
    metadata?: Record<string, unknown>,
  ) {
    const id = randomUUID();
    const now = new Date();
    await this.db.db.insert(notifications).values({
      id,
      userId,
      message,
      level,
      read: false,
      metadata: metadata ? JSON.stringify(metadata) : null,
      createdAt: now,
    });

    // Push via WebSocket
    this.events.emitToChannel('notifications', 'notification:new', {
      id,
      message,
      level,
      read: false,
      metadata,
      createdAt: now.toISOString(),
    });

    return { id, message, level, read: false, metadata, createdAt: now.toISOString() };
  }

  async getForUser(userId: string, limit = 50) {
    return this.db.db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, userId))
      .orderBy(desc(notifications.createdAt))
      .limit(limit);
  }

  async markRead(userId: string, id: string) {
    await this.db.db
      .update(notifications)
      .set({ read: true })
      .where(and(eq(notifications.id, id), eq(notifications.userId, userId)));
  }

  async markAllRead(userId: string) {
    await this.db.db
      .update(notifications)
      .set({ read: true })
      .where(and(eq(notifications.userId, userId), eq(notifications.read, false)));
  }

  async dismiss(userId: string, id: string) {
    await this.db.db
      .delete(notifications)
      .where(and(eq(notifications.id, id), eq(notifications.userId, userId)));
  }
}
