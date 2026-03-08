import { Controller, Get, Post, Patch, Delete, Param, Query, Body } from '@nestjs/common';
import { ContactsService } from './contacts.service';
import { RequiresJwt } from '../user-auth/decorators/requires-jwt.decorator';
import { CurrentUser } from '../user-auth/decorators/current-user.decorator';
import { UpdateContactDto } from './dto/update-contact.dto';
import { SplitContactDto } from './dto/split-contact.dto';
import { MergeContactDto } from './dto/merge-contact.dto';
import { SearchContactsDto } from './dto/search-contacts.dto';
import { DismissSuggestionDto } from './dto/dismiss-suggestion.dto';

@Controller('people')
export class ContactsController {
  constructor(private contactsService: ContactsService) {}

  @Get()
  async list(
    @CurrentUser() user: { id: string },
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('entityType') entityType?: string,
  ) {
    return this.contactsService.list({
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
      entityType,
      userId: user.id,
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
  async update(@Param('id') id: string, @Body() dto: UpdateContactDto) {
    return this.contactsService.updateContact(id, dto);
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
  async split(@Param('id') id: string, @Body() dto: SplitContactDto) {
    return this.contactsService.splitContact(id, dto.identifierIds);
  }

  @Post('search')
  async search(@Body() dto: SearchContactsDto) {
    return this.contactsService.search(dto.query);
  }

  @RequiresJwt()
  @Post(':id/merge')
  async merge(@Param('id') id: string, @Body() dto: MergeContactDto) {
    return this.contactsService.mergeContacts(id, dto.sourceId);
  }

  @RequiresJwt()
  @Post('normalize')
  async normalize() {
    return this.contactsService.normalizeAll();
  }

  @RequiresJwt()
  @Post('suggestions/dismiss')
  async dismissSuggestion(@Body() dto: DismissSuggestionDto) {
    await this.contactsService.dismissSuggestion(dto.contactId1, dto.contactId2);
    return { dismissed: true };
  }

  @RequiresJwt()
  @Post('suggestions/undismiss')
  async undismissSuggestion(@Body() dto: DismissSuggestionDto) {
    await this.contactsService.undismissSuggestion(dto.contactId1, dto.contactId2);
    return { undismissed: true };
  }

}
