import { Controller, Get, Post, Patch, Delete, Param, Body } from '@nestjs/common';
import { AccountsService } from './accounts.service';
import { CurrentUser } from '../user-auth/decorators/current-user.decorator';
import { RequiresJwt } from '../user-auth/decorators/requires-jwt.decorator';
import { CreateAccountDto } from './dto/create-account.dto';
import { UpdateAccountDto } from './dto/update-account.dto';
import type { ConnectorAccount } from '@botmem/shared';

function toApiAccount(row: any): ConnectorAccount {
  return {
    id: row.id,
    type: row.connectorType,
    identifier: row.identifier,
    status: row.status,
    schedule: row.schedule,
    lastSync: row.lastSyncAt,
    memoriesIngested: row.itemsSynced,
    lastError: row.lastError || null,
  };
}

@Controller('accounts')
export class AccountsController {
  constructor(private accountsService: AccountsService) {}

  @Get()
  async list(@CurrentUser() user: { id: string }) {
    const rows = await this.accountsService.getAll(user.id);
    return { accounts: rows.map(toApiAccount) };
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    return toApiAccount(await this.accountsService.getById(id));
  }

  @RequiresJwt()
  @Post()
  async create(
    @CurrentUser() user: { id: string },
    @Body() dto: CreateAccountDto,
  ) {
    // Dedup: return existing account if one already exists for this connector+identifier FOR THIS USER
    const existing = await this.accountsService.findByTypeAndIdentifier(dto.connectorType, dto.identifier, user.id);
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
