import { Controller, Get, Post, Patch, Delete, Param, Query, Body } from '@nestjs/common';
import { ContactsService } from './contacts.service';
import { RequiresJwt } from '../user-auth/decorators/requires-jwt.decorator';

@Controller('people')
export class ContactsController {
  constructor(private contactsService: ContactsService) {}

  @Get()
  async list(
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('entityType') entityType?: string,
  ) {
    return this.contactsService.list({
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
      entityType,
    });
  }

  @Get('suggestions')
  async getSuggestions() {
    return this.contactsService.getSuggestions();
  }

  @RequiresJwt()
  @Post('auto-merge')
  async autoMerge() {
    return this.contactsService.autoMerge();
  }

  @RequiresJwt()
  @Post('reclassify')
  async reclassify() {
    return this.contactsService.reclassifyEntityTypes();
  }

  @Get(':id')
  async getById(@Param('id') id: string) {
    return this.contactsService.getById(id);
  }

  @Get(':id/memories')
  async getMemories(@Param('id') id: string) {
    return this.contactsService.getMemories(id);
  }

  @RequiresJwt()
  @Patch(':id')
  async update(@Param('id') id: string, @Body() body: {
    displayName?: string;
    avatars?: Array<{ url: string; source: string }>;
    metadata?: Record<string, unknown>;
  }) {
    return this.contactsService.updateContact(id, body);
  }

  @RequiresJwt()
  @Delete(':id')
  async delete(@Param('id') id: string) {
    await this.contactsService.deleteContact(id);
    return { deleted: true };
  }

  @RequiresJwt()
  @Delete(':id/identifiers/:identId')
  async removeIdentifier(@Param('id') id: string, @Param('identId') identId: string) {
    return this.contactsService.removeIdentifier(id, identId);
  }

  @RequiresJwt()
  @Post(':id/split')
  async split(@Param('id') id: string, @Body() body: { identifierIds: string[] }) {
    return this.contactsService.splitContact(id, body.identifierIds);
  }

  @Post('search')
  async search(@Body() body: { query: string }) {
    return this.contactsService.search(body.query);
  }

  @RequiresJwt()
  @Post(':id/merge')
  async merge(@Param('id') id: string, @Body() body: { sourceId: string }) {
    return this.contactsService.mergeContacts(id, body.sourceId);
  }

  @RequiresJwt()
  @Post('normalize')
  async normalize() {
    return this.contactsService.normalizeAll();
  }

  @RequiresJwt()
  @Post('suggestions/dismiss')
  async dismissSuggestion(@Body() body: { contactId1: string; contactId2: string }) {
    await this.contactsService.dismissSuggestion(body.contactId1, body.contactId2);
    return { dismissed: true };
  }

  @RequiresJwt()
  @Post('suggestions/undismiss')
  async undismissSuggestion(@Body() body: { contactId1: string; contactId2: string }) {
    await this.contactsService.undismissSuggestion(body.contactId1, body.contactId2);
    return { undismissed: true };
  }

}
