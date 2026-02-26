import { Controller, Get, Patch, Body } from '@nestjs/common';
import { SettingsService } from './settings.service';

@Controller('settings')
export class SettingsController {
  constructor(private settingsService: SettingsService) {}

  @Get()
  getAll() {
    return this.settingsService.getAll();
  }

  @Patch()
  update(@Body() body: Record<string, string>) {
    for (const [key, value] of Object.entries(body)) {
      this.settingsService.set(key, String(value));
    }
    return this.settingsService.getAll();
  }
}
