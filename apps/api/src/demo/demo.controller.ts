import { Controller, Post, Delete, Body, Logger } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { randomUUID } from 'crypto';
import { eq, and, like, sql } from 'drizzle-orm';
import { CurrentUser } from '../user-auth/decorators/current-user.decorator';
import { Public } from '../user-auth/decorators/public.decorator';
import { DemoService } from './demo.service';
import { DbService } from '../db/db.service';
import * as schema from '../db/schema';

@ApiTags('Demo')
@ApiBearerAuth()
@Controller('demo')
export class DemoController {
  private readonly logger = new Logger(DemoController.name);

  constructor(
    private demo: DemoService,
    private db: DbService,
  ) {}

  @Post('seed')
  async seed(@CurrentUser() user: { id: string }) {
    // Check if demo data already exists
    const exists = await this.demo.hasDemoData(user.id);
    if (exists) {
      return { ok: false, error: 'Demo data already exists. Delete it first.' };
    }

    // Get the user's default memory bank
    const banks = await this.db.db
      .select()
      .from(schema.memoryBanks)
      .where(and(eq(schema.memoryBanks.userId, user.id), eq(schema.memoryBanks.isDefault, true)))
      .limit(1);

    let memoryBankId: string;
    if (banks.length > 0) {
      memoryBankId = banks[0].id;
    } else {
      // Create a default memory bank
      memoryBankId = randomUUID();
      await this.db.db.insert(schema.memoryBanks).values({
        id: memoryBankId,
        userId: user.id,
        name: 'Default',
        isDefault: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }

    const result = await this.demo.seed(user.id, memoryBankId);
    return { ok: true, ...result };
  }

  @Delete('seed')
  async cleanup(@CurrentUser() user: { id: string }) {
    const result = await this.demo.cleanup(user.id);
    return { ok: true, ...result };
  }

  @Post('status')
  async status(@CurrentUser() user: { id: string }) {
    const exists = await this.demo.hasDemoData(user.id);
    return { hasDemoData: exists };
  }

  /** Clean up test users matching a specific email pattern. Only works in non-production. */
  @Public()
  @Post('cleanup-test-users')
  async cleanupTestUsers(@Body() body: { emailPattern: string }) {
    const pattern = body.emailPattern;
    if (!pattern || !pattern.includes('@test.botmem.xyz')) {
      return { ok: false, error: 'Pattern must target @test.botmem.xyz emails' };
    }

    try {
      // Find test user IDs
      const testUsers = await this.db.db
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(like(schema.users.email, pattern));

      if (testUsers.length === 0) return { ok: true, deleted: 0 };

      // Atomic cleanup — PL/pgSQL DO blocks can't use bind params, so we
      // use sql.raw for the pattern (already validated to be @test.botmem.xyz).
      // Escape single quotes to prevent SQL injection.
      const safePattern = pattern.replace(/'/g, "''");
      await this.db.db.execute(sql`
        DO $$
        DECLARE
          _uids text[] := ARRAY(SELECT id FROM users WHERE email LIKE '${sql.raw(safePattern)}');
          _aids text[] := ARRAY(SELECT id FROM accounts WHERE user_id = ANY(_uids));
          _mids text[] := ARRAY(SELECT id FROM memories WHERE account_id = ANY(_aids));
          _pids text[] := ARRAY(SELECT id FROM people WHERE user_id = ANY(_uids));
        BEGIN
          DELETE FROM memory_links WHERE src_memory_id = ANY(_mids) OR dst_memory_id = ANY(_mids);
          DELETE FROM memory_people WHERE memory_id = ANY(_mids);
          DELETE FROM memories WHERE id = ANY(_mids);
          DELETE FROM accounts WHERE id = ANY(_aids);
          DELETE FROM person_identifiers WHERE person_id = ANY(_pids);
          DELETE FROM people WHERE id = ANY(_pids);
          DELETE FROM refresh_tokens WHERE user_id = ANY(_uids);
          DELETE FROM api_keys WHERE user_id = ANY(_uids);
          DELETE FROM memory_banks WHERE user_id = ANY(_uids);
          DELETE FROM users WHERE id = ANY(_uids);
        END $$
      `);

      this.logger.log(`Cleaned up ${testUsers.length} test users`);
      return { ok: true, deleted: testUsers.length };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Cleanup test users failed: ${message}`);
      return { ok: false, error: message };
    }
  }
}
