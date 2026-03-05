import { Controller, Get, Post, Patch, Delete, Param, Query, Body } from '@nestjs/common';
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

  @Get('suggestions')
  async getSuggestions() {
    return this.contactsService.getSuggestions();
  }

  @Get(':id')
  async getById(@Param('id') id: string) {
    return this.contactsService.getById(id);
  }

  @Get(':id/memories')
  async getMemories(@Param('id') id: string) {
    return this.contactsService.getMemories(id);
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() body: {
    displayName?: string;
    avatars?: Array<{ url: string; source: string }>;
    metadata?: Record<string, unknown>;
  }) {
    return this.contactsService.updateContact(id, body);
  }

  @Delete(':id')
  async delete(@Param('id') id: string) {
    await this.contactsService.deleteContact(id);
    return { deleted: true };
  }

  @Post('search')
  async search(@Body() body: { query: string }) {
    return this.contactsService.search(body.query);
  }

  @Post(':id/merge')
  async merge(@Param('id') id: string, @Body() body: { sourceId: string }) {
    return this.contactsService.mergeContacts(id, body.sourceId);
  }

  @Post('normalize')
  async normalize() {
    return this.contactsService.normalizeAll();
  }

  @Post('suggestions/dismiss')
  async dismissSuggestion(@Body() body: { contactId1: string; contactId2: string }) {
    await this.contactsService.dismissSuggestion(body.contactId1, body.contactId2);
    return { dismissed: true };
  }
}
