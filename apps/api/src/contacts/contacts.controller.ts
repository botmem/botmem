import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Query,
  Body,
  Res,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ContactsService } from './contacts.service';
import { AccountsService } from '../accounts/accounts.service';
import { RequiresJwt } from '../user-auth/decorators/requires-jwt.decorator';
import { CurrentUser } from '../user-auth/decorators/current-user.decorator';
import { UpdateContactDto } from './dto/update-contact.dto';
import { SplitContactDto } from './dto/split-contact.dto';
import { MergeContactDto } from './dto/merge-contact.dto';
import { SearchContactsDto } from './dto/search-contacts.dto';
import { DismissSuggestionDto } from './dto/dismiss-suggestion.dto';
import { ReadOnly } from '../user-auth/decorators/read-only.decorator';

@ApiTags('Contacts')
@ApiBearerAuth()
@Controller('people')
export class ContactsController {
  private readonly logger = new Logger(ContactsController.name);
  constructor(
    private contactsService: ContactsService,
    private accountsService: AccountsService,
  ) {}

  @Get()
  async list(
    @CurrentUser() user: { id: string },
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('entityType') entityType?: string,
  ) {
    const t0 = performance.now();
    const result = await this.contactsService.list({
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
      entityType,
      userId: user.id,
    });
    this.logger.log(
      `[PROFILE] GET /people (${entityType}, offset=${offset || 0}, limit=${limit || 50}) → ${result.items.length}/${result.total} items in ${(performance.now() - t0).toFixed(0)}ms`,
    );
    return result;
  }

  @Get('suggestions')
  async getSuggestions(@CurrentUser() user: { id: string }) {
    const t0 = performance.now();
    const result = await this.contactsService.getSuggestions(user.id);
    this.logger.log(
      `[PROFILE] GET /people/suggestions → ${result.length} suggestions in ${(performance.now() - t0).toFixed(0)}ms`,
    );
    return result;
  }

  @RequiresJwt()
  @Post('auto-merge')
  async autoMerge() {
    const t0 = performance.now();
    const result = await this.contactsService.autoMerge();
    this.logger.log(
      `[PROFILE] POST /people/auto-merge → ${JSON.stringify(result)} in ${(performance.now() - t0).toFixed(0)}ms`,
    );
    return result;
  }

  @RequiresJwt()
  @Post('reclassify')
  async reclassify() {
    return this.contactsService.reclassifyEntityTypes();
  }

  @RequiresJwt()
  @Post('backfill-avatars')
  async backfillAvatars() {
    return this.contactsService.backfillAvatarData();
  }

  @Get(':id/avatar')
  async getAvatar(
    @Param('id') id: string,
    @Query('index') indexStr: string | undefined,
    @CurrentUser() _user: { id: string },
    @Res() res: Response,
  ) {
    let contact: Awaited<ReturnType<typeof this.contactsService.getById>>;
    try {
      contact = await this.contactsService.getById(id);
    } catch {
      return res.status(HttpStatus.NOT_FOUND).json({ error: 'contact not found' });
    }

    const allAvatars = (contact!.avatars as Array<{ url: string; source: string }>) || [];
    if (allAvatars.length === 0) {
      return res.status(HttpStatus.NOT_FOUND).json({ error: 'no avatar' });
    }

    // If a specific index is requested, serve only that avatar
    const requestedIndex = indexStr != null ? parseInt(indexStr, 10) : undefined;
    const avatars =
      requestedIndex != null && allAvatars[requestedIndex]
        ? [allAvatars[requestedIndex]]
        : allAvatars;

    // Cache Immich credentials once (lazy)
    let immichApiKey: string | null = null;
    const getImmichKey = async () => {
      if (immichApiKey !== null) return immichApiKey;
      try {
        const allAccounts = await this.accountsService.getAll();
        const photosAccount = allAccounts.find((a) => a.connectorType === 'photos');
        if (photosAccount?.authContext) {
          const auth =
            typeof photosAccount.authContext === 'string'
              ? JSON.parse(photosAccount.authContext)
              : photosAccount.authContext;
          immichApiKey = auth?.accessToken || '';
        } else {
          immichApiKey = '';
        }
      } catch (err) {
        this.logger.warn(
          `Failed to get Immich credentials: ${err instanceof Error ? err.message : String(err)}`,
        );
        immichApiKey = '';
      }
      return immichApiKey;
    };

    // Try each avatar in order until one succeeds
    for (const avatar of avatars) {
      // Serve base64 data URIs directly from DB
      if (avatar.url.startsWith('data:')) {
        const match = avatar.url.match(/^data:([^;]+);base64,(.+)$/);
        if (match) {
          res.setHeader('Content-Type', match[1]);
          res.setHeader('Cache-Control', 'public, max-age=86400');
          return res.send(Buffer.from(match[2], 'base64'));
        }
        continue;
      }

      // Validate URL: only allow https:// (block private IPs to prevent SSRF)
      try {
        const parsed = new URL(avatar.url);
        const protocol = parsed.protocol.toLowerCase();
        if (protocol !== 'https:') continue;

        const hostname = parsed.hostname.toLowerCase();
        const bare =
          hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;

        // Block IPv6 private/link-local
        if (
          bare === '::1' ||
          bare.startsWith('fc') ||
          bare.startsWith('fd') ||
          bare.startsWith('fe80')
        )
          continue;

        // Block localhost
        if (bare === 'localhost' || bare.endsWith('.localhost')) continue;

        // Block IPv4 private/link-local/loopback
        const ipv4Match = bare.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
        if (ipv4Match) {
          const [, a, b] = ipv4Match.map(Number);
          if (
            a === 127 ||
            a === 10 ||
            (a === 172 && b >= 16 && b <= 31) ||
            (a === 192 && b === 168) ||
            (a === 169 && b === 254) ||
            a === 0
          )
            continue;
        }
      } catch {
        continue;
      }

      // Fetch external URLs (legacy data)
      const headers: Record<string, string> = {};
      if (avatar.source === 'immich') {
        const key = await getImmichKey();
        if (key) headers['x-api-key'] = key;
      }

      try {
        const upstream = await fetch(avatar.url, { headers, signal: AbortSignal.timeout(10_000) });
        if (!upstream.ok) continue;

        const contentType = upstream.headers.get('content-type') || 'image/jpeg';
        res.setHeader('Content-Type', contentType);
        res.setHeader('Cache-Control', 'public, max-age=86400');

        const buffer = Buffer.from(await upstream.arrayBuffer());
        return res.send(buffer);
      } catch {
        continue;
      }
    }

    return res.status(HttpStatus.NOT_FOUND).json({ error: 'all avatars failed' });
  }

  @Get(':id')
  async getById(@Param('id') id: string) {
    const t0 = performance.now();
    const result = await this.contactsService.getById(id);
    this.logger.log(`[PROFILE] GET /people/${id} in ${(performance.now() - t0).toFixed(0)}ms`);
    return result;
  }

  @Get(':id/memories')
  async getMemories(@CurrentUser() user: { id: string }, @Param('id') id: string) {
    const t0 = performance.now();
    const result = await this.contactsService.getMemories(id, undefined, user.id);
    this.logger.log(
      `[PROFILE] GET /people/${id}/memories → ${Array.isArray(result) ? result.length : '?'} in ${(performance.now() - t0).toFixed(0)}ms`,
    );
    return result;
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

  @ReadOnly()
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @Post('search')
  async search(@Body() dto: SearchContactsDto) {
    const t0 = performance.now();
    const result = await this.contactsService.search(dto.query);
    this.logger.log(
      `[PROFILE] POST /people/search q="${dto.query}" → ${result.length} results in ${(performance.now() - t0).toFixed(0)}ms`,
    );
    return result;
  }

  @RequiresJwt()
  @Post(':id/merge')
  async merge(@Param('id') id: string, @Body() dto: MergeContactDto) {
    const t0 = performance.now();
    const result = await this.contactsService.mergeContacts(id, dto.sourceId);
    this.logger.log(
      `[PROFILE] POST /people/${id}/merge (source=${dto.sourceId}) in ${(performance.now() - t0).toFixed(0)}ms`,
    );
    return result;
  }

  @RequiresJwt()
  @Post('normalize')
  async normalize() {
    return this.contactsService.normalizeAll();
  }

  @RequiresJwt()
  @Post('suggestions/dismiss')
  async dismissSuggestion(@Body() dto: DismissSuggestionDto) {
    const t0 = performance.now();
    await this.contactsService.dismissSuggestion(dto.contactId1, dto.contactId2);
    this.logger.log(
      `[PROFILE] POST /people/suggestions/dismiss in ${(performance.now() - t0).toFixed(0)}ms`,
    );
    return { dismissed: true };
  }

  @RequiresJwt()
  @Post('suggestions/undismiss')
  async undismissSuggestion(@Body() dto: DismissSuggestionDto) {
    const t0 = performance.now();
    await this.contactsService.undismissSuggestion(dto.contactId1, dto.contactId2);
    this.logger.log(
      `[PROFILE] POST /people/suggestions/undismiss in ${(performance.now() - t0).toFixed(0)}ms`,
    );
    return { undismissed: true };
  }
}
