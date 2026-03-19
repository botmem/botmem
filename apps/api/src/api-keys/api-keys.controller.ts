import { Controller, Get, Post, Delete, Param, Body } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ApiKeysService } from './api-keys.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { CurrentUser } from '../user-auth/decorators/current-user.decorator';
import { RequiresJwt } from '../user-auth/decorators/requires-jwt.decorator';
import { CreateApiKeyDto } from './dto/create-api-key.dto';

@ApiTags('API Keys')
@ApiBearerAuth()
@RequiresJwt()
@Controller('api-keys')
export class ApiKeysController {
  constructor(
    private apiKeysService: ApiKeysService,
    private analytics: AnalyticsService,
  ) {}

  @Post()
  async create(@CurrentUser() user: { id: string }, @Body() dto: CreateApiKeyDto) {
    const result = await this.apiKeysService.create(
      user.id,
      dto.name,
      dto.expiresAt,
      dto.memoryBankIds,
    );
    this.analytics.capture(
      'api_key_created',
      {
        has_expiry: !!dto.expiresAt,
        memory_bank_count: dto.memoryBankIds?.length ?? 0,
      },
      user.id,
    );
    return result;
  }

  @Get()
  async list(@CurrentUser() user: { id: string }) {
    return this.apiKeysService.listByUser(user.id);
  }

  @Delete(':id')
  async revoke(@CurrentUser() user: { id: string }, @Param('id') id: string) {
    await this.apiKeysService.revoke(user.id, id);
    this.analytics.capture('api_key_revoked', {}, user.id);
    return { success: true };
  }
}
