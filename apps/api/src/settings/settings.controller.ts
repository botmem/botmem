import { Controller, Get, Patch, Body } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { SettingsService } from './settings.service';
import { RequiresJwt } from '../user-auth/decorators/requires-jwt.decorator';
import { CurrentUser } from '../user-auth/decorators/current-user.decorator';
import { UpdateSettingsDto } from './dto/update-settings.dto';

@ApiTags('Settings')
@ApiBearerAuth()
@Controller('settings')
export class SettingsController {
  constructor(private settingsService: SettingsService) {}

  @RequiresJwt()
  @Get()
  getAll(@CurrentUser() user: { id: string }) {
    return this.settingsService.getAll(user.id);
  }

  @RequiresJwt()
  @Patch()
  async update(@CurrentUser() user: { id: string }, @Body() body: UpdateSettingsDto) {
    for (const [key, value] of Object.entries(body.settings)) {
      await this.settingsService.set(user.id, key, value);
    }
    return this.settingsService.getAll(user.id);
  }
}
