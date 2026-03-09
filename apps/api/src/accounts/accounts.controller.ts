import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  ForbiddenException,
} from '@nestjs/common';
import { AccountsService } from './accounts.service';
import { DbService } from '../db/db.service';
import { memories } from '../db/schema';
import { sql } from 'drizzle-orm';
import { CurrentUser } from '../user-auth/decorators/current-user.decorator';
import { RequiresJwt } from '../user-auth/decorators/requires-jwt.decorator';
import { CreateAccountDto } from './dto/create-account.dto';
import { UpdateAccountDto } from './dto/update-account.dto';
import type { ConnectorAccount } from '@botmem/shared';

function toApiAccount(row: any, memoryCount?: number): ConnectorAccount {
  return {
    id: row.id,
    type: row.connectorType,
    identifier: row.identifier,
    status: row.status,
    schedule: row.schedule,
    lastSync: row.lastSyncAt,
    memoriesIngested: memoryCount ?? row.itemsSynced,
    lastError: row.lastError || null,
  };
}

@Controller('accounts')
export class AccountsController {
  constructor(
    private accountsService: AccountsService,
    private dbService: DbService,
  ) {}

  @Get()
  async list(@CurrentUser() user: { id: string }) {
    const rows = await this.accountsService.getAll(user.id);
    // Count actual memories per account from DB
    const counts = await this.dbService.db
      .select({ accountId: memories.accountId, count: sql<number>`count(*)::int` })
      .from(memories)
      .groupBy(memories.accountId);
    const countMap = new Map(counts.map((c) => [c.accountId, c.count]));
    return { accounts: rows.map((r) => toApiAccount(r, countMap.get(r.id) ?? 0)) };
  }

  @Get(':id')
  async get(@CurrentUser() user: { id: string }, @Param('id') id: string) {
    const account = await this.accountsService.getById(id);
    if (account.userId !== user.id) {
      throw new ForbiddenException('Account does not belong to user');
    }
    return toApiAccount(account);
  }

  @RequiresJwt()
  @Post()
  async create(@CurrentUser() user: { id: string }, @Body() dto: CreateAccountDto) {
    // Dedup: return existing account if one already exists for this connector+identifier FOR THIS USER
    const existing = await this.accountsService.findByTypeAndIdentifier(
      dto.connectorType,
      dto.identifier,
      user.id,
    );
    if (existing) return toApiAccount(existing);
    const row = await this.accountsService.create({ ...dto, userId: user.id });
    return toApiAccount(row);
  }

  @RequiresJwt()
  @Patch(':id')
  async update(@Param('id') id: string, @Body() dto: UpdateAccountDto) {
    const row = await this.accountsService.update(id, dto);
    return toApiAccount(row);
  }

  @RequiresJwt()
  @Delete(':id')
  async remove(@Param('id') id: string) {
    await this.accountsService.remove(id);
    return { ok: true };
  }
}
