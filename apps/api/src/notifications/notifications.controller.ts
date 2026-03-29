import { Controller, Get, Put, Delete, Param, Req } from '@nestjs/common';
import { NotificationsService } from './notifications.service';

@Controller('notifications')
export class NotificationsController {
  constructor(private notifications: NotificationsService) {}

  @Get()
  async list(@Req() req: any) {
    const userId = req.user?.id;
    const rows = await this.notifications.getForUser(userId);
    return rows.map((r) => ({
      ...r,
      metadata: r.metadata ? JSON.parse(r.metadata) : null,
    }));
  }

  @Put(':id/read')
  async markRead(@Req() req: any, @Param('id') id: string) {
    const userId = req.user?.id;
    await this.notifications.markRead(userId, id);
    return { ok: true };
  }

  @Put('read-all')
  async markAllRead(@Req() req: any) {
    const userId = req.user?.id;
    await this.notifications.markAllRead(userId);
    return { ok: true };
  }

  @Delete(':id')
  async dismiss(@Req() req: any, @Param('id') id: string) {
    const userId = req.user?.id;
    await this.notifications.dismiss(userId, id);
    return { ok: true };
  }
}
