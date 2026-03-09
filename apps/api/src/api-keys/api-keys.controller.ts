import { Controller, Get, Post, Delete, Param, Body } from '@nestjs/common';
import { ApiKeysService } from './api-keys.service';
import { CurrentUser } from '../user-auth/decorators/current-user.decorator';
import { RequiresJwt } from '../user-auth/decorators/requires-jwt.decorator';
import { CreateApiKeyDto } from './dto/create-api-key.dto';

@RequiresJwt()
@Controller('api-keys')
export class ApiKeysController {
  constructor(private apiKeysService: ApiKeysService) {}

  @Post()
  async create(@CurrentUser() user: { id: string }, @Body() dto: CreateApiKeyDto) {
    return this.apiKeysService.create(user.id, dto.name, dto.expiresAt, dto.memoryBankIds);
  }

  @Get()
  async list(@CurrentUser() user: { id: string }) {
    return this.apiKeysService.listByUser(user.id);
  }

  @Delete(':id')
  async revoke(@CurrentUser() user: { id: string }, @Param('id') id: string) {
    await this.apiKeysService.revoke(user.id, id);
    return { success: true };
  }
}
