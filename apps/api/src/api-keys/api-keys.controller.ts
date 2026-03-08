import { Controller, Get, Post, Delete, Param, Body } from '@nestjs/common';
import { ApiKeysService } from './api-keys.service';
import { CurrentUser } from '../user-auth/decorators/current-user.decorator';
import { RequiresJwt } from '../user-auth/decorators/requires-jwt.decorator';

@RequiresJwt()
@Controller('api-keys')
export class ApiKeysController {
  constructor(private apiKeysService: ApiKeysService) {}

  @Post()
  async create(
    @CurrentUser() user: { id: string },
    @Body() body: { name: string; expiresAt?: string },
  ) {
    return this.apiKeysService.create(user.id, body.name, body.expiresAt);
  }

  @Get()
  async list(@CurrentUser() user: { id: string }) {
    return this.apiKeysService.listByUser(user.id);
  }

  @Delete(':id')
  async revoke(
    @CurrentUser() user: { id: string },
    @Param('id') id: string,
  ) {
    await this.apiKeysService.revoke(user.id, id);
    return { success: true };
  }
}
