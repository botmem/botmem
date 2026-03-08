import { Controller, Get, Post, Body, HttpException, HttpStatus } from '@nestjs/common';
import { MeService } from './me.service';
import { CurrentUser } from '../user-auth/decorators/current-user.decorator';

@Controller('me')
export class MeController {
  constructor(private meService: MeService) {}

  @Get('status')
  async getStatus(@CurrentUser() user: { id: string }) {
    return this.meService.getStatus(user.id);
  }

  @Get('merge-candidates')
  async getMergeCandidates(@CurrentUser() user: { id: string }) {
    return this.meService.getMergeCandidates(user.id);
  }

  @Post('set')
  async setSelfContact(@CurrentUser() user: { id: string }, @Body() body: { contactId: string }) {
    if (!body?.contactId) {
      throw new HttpException('contactId is required', HttpStatus.BAD_REQUEST);
    }
    try {
      return await this.meService.setSelfContact(body.contactId, user.id);
    } catch (err: any) {
      throw new HttpException(err.message || 'Failed to set self contact', HttpStatus.NOT_FOUND);
    }
  }

  @Get()
  async getMe(@CurrentUser() user: { id: string }) {
    return this.meService.getMe(user.id);
  }
}
