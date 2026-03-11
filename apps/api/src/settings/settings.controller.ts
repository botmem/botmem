import { Controller, Get, Patch, Body } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { SettingsService } from './settings.service';
import { RequiresJwt } from '../user-auth/decorators/requires-jwt.decorator';

@ApiTags('Settings')
@ApiBearerAuth()
@Controller('settings')
export class SettingsController {
  constructor(private settingsService: SettingsService) {}

  @Get()
  getAll() {
    return this.settingsService.getAll();
  }

  @RequiresJwt()
  @Patch()
  async update(@Body() body: Record<string, string>) {
    for (const [key, value] of Object.entries(body)) {
      await this.settingsService.set(key, String(value));
    }
    return this.settingsService.getAll();
  }
}
