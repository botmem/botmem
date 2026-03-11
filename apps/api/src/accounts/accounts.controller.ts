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
import { memories, memoryContacts, contacts } from '../db/schema';
import { sql, eq, inArray } from 'drizzle-orm';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../user-auth/decorators/current-user.decorator';
import { RequiresJwt } from '../user-auth/decorators/requires-jwt.decorator';
import { CreateAccountDto } from './dto/create-account.dto';
import { UpdateAccountDto } from './dto/update-account.dto';
import type { ConnectorAccount } from '@botmem/shared';

function toApiAccount(
  row: any,
  memoryCount?: number,
  contactsCount?: number,
  groupsCount?: number,
): ConnectorAccount {
  return {
    id: row.id,
    type: row.connectorType,
    identifier: row.identifier,
    status: row.status,
    schedule: row.schedule,
    lastSync: row.lastSyncAt,
    memoriesIngested: memoryCount ?? row.itemsSynced,
    contactsCount: contactsCount ?? 0,
    groupsCount: groupsCount ?? 0,
    lastError: row.lastError || null,
  };
}

@ApiTags('Accounts')
@ApiBearerAuth()
@Controller('accounts')
export class AccountsController {
  constructor(
    private accountsService: AccountsService,
    private dbService: DbService,
  ) {}

  @Get()
  async list(@CurrentUser() user: { id: string }) {
    const rows = await this.accountsService.getAll(user.id);

    return this.dbService.withCurrentUser(async (db) => {
      // Count actual memories per account from DB
      const memoryCounts = await db
        .select({ accountId: memories.accountId, count: sql<number>`count(*)::int` })
        .from(memories)
        .groupBy(memories.accountId);
      const memoryCountMap = new Map(memoryCounts.map((c) => [c.accountId, c.count]));

      // Count contacts and groups per account via memoryContacts → memories
      const accountIds = rows.map((r) => r.id);
      const contactCountRows = accountIds.length
        ? await db
            .select({
              accountId: memories.accountId,
              entityType: contacts.entityType,
              count: sql<number>`count(distinct ${contacts.id})::int`,
            })
            .from(memoryContacts)
            .innerJoin(memories, eq(memoryContacts.memoryId, memories.id))
            .innerJoin(contacts, eq(memoryContacts.contactId, contacts.id))
            .where(inArray(memories.accountId, accountIds))
            .groupBy(memories.accountId, contacts.entityType)
        : [];

      const contactsMap = new Map<string, number>();
      const groupsMap = new Map<string, number>();
      for (const row of contactCountRows) {
        if (row.entityType === 'group') {
          groupsMap.set(row.accountId!, (groupsMap.get(row.accountId!) || 0) + row.count);
        } else {
          contactsMap.set(row.accountId!, (contactsMap.get(row.accountId!) || 0) + row.count);
        }
      }

      return {
        accounts: rows.map((r) =>
          toApiAccount(
            r,
            memoryCountMap.get(r.id) ?? 0,
            contactsMap.get(r.id) ?? 0,
            groupsMap.get(r.id) ?? 0,
          ),
        ),
      };
    });
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
