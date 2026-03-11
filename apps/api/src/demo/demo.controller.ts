import { Controller, Post, Delete, Logger } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { randomUUID } from 'crypto';
import { eq, and } from 'drizzle-orm';
import { CurrentUser } from '../user-auth/decorators/current-user.decorator';
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
}
