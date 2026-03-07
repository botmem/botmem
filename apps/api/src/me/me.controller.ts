import { Controller, Get, Query, HttpException, HttpStatus } from '@nestjs/common';
import { MeService } from './me.service';

@Controller('me')
export class MeController {
  constructor(private meService: MeService) {}

  @Get('status')
  async getStatus() {
    return this.meService.getStatus();
  }

  @Get('merge-candidates')
  async getMergeCandidates() {
    return this.meService.getMergeCandidates();
  }

  @Get('set')
  async setSelfContact(@Query('contactId') contactId: string) {
    if (!contactId) {
      throw new HttpException('contactId query parameter is required', HttpStatus.BAD_REQUEST);
    }
    try {
      return await this.meService.setSelfContact(contactId);
    } catch (err: any) {
      throw new HttpException(err.message || 'Failed to set self contact', HttpStatus.NOT_FOUND);
    }
  }

  @Get()
  async getMe() {
    return this.meService.getMe();
  }
}
