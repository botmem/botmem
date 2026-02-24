import { Controller, Get, Post, Patch, Delete, Param, Body } from '@nestjs/common';
import { AccountsService } from './accounts.service';
import type { ConnectorAccount, SyncSchedule } from '@botmem/shared';

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
  async list() {
    const rows = await this.accountsService.getAll();
    return { accounts: rows.map(toApiAccount) };
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    return toApiAccount(await this.accountsService.getById(id));
  }

  @Post()
  async create(@Body() body: { connectorType: string; identifier: string }) {
    const row = await this.accountsService.create(body);
    return toApiAccount(row);
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() body: { schedule?: SyncSchedule }) {
    const row = await this.accountsService.update(id, body);
    return toApiAccount(row);
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    await this.accountsService.remove(id);
    return { ok: true };
  }
}
