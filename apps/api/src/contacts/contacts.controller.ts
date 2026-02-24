import { Controller, Get, Post, Param, Query, Body } from '@nestjs/common';
import { ContactsService } from './contacts.service';

@Controller('contacts')
export class ContactsController {
  constructor(private contactsService: ContactsService) {}

  @Get()
  async list(@Query('limit') limit?: string, @Query('offset') offset?: string) {
    return this.contactsService.list({
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
    });
  }

  @Get(':id')
  async getById(@Param('id') id: string) {
    return this.contactsService.getById(id);
  }

  @Get(':id/memories')
  async getMemories(@Param('id') id: string) {
    return this.contactsService.getMemories(id);
  }

  @Post('search')
  async search(@Body() body: { query: string }) {
    return this.contactsService.search(body.query);
  }

  @Post(':id/merge')
  async merge(@Param('id') id: string, @Body() body: { mergeWithId: string }) {
    return this.contactsService.resolveContact([]);
  }
}
