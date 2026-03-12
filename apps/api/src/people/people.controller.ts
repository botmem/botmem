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
import { PeopleService } from './people.service';
import { AccountsService } from '../accounts/accounts.service';
import { RequiresJwt } from '../user-auth/decorators/requires-jwt.decorator';
import { CurrentUser } from '../user-auth/decorators/current-user.decorator';
import { UpdatePersonDto } from './dto/update-person.dto';
import { SplitPersonDto } from './dto/split-person.dto';
import { MergePersonDto } from './dto/merge-person.dto';
import { SearchPeopleDto } from './dto/search-people.dto';
import { DismissSuggestionDto } from './dto/dismiss-suggestion.dto';
import { ReadOnly } from '../user-auth/decorators/read-only.decorator';

@ApiTags('People')
@ApiBearerAuth()
@Controller('people')
export class PeopleController {
  private readonly logger = new Logger(PeopleController.name);
  constructor(
    private peopleService: PeopleService,
    private accountsService: AccountsService,
  ) {}

  @Get()
  async list(
    @CurrentUser() user: { id: string },
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('entityType') entityType?: string,
  ) {
    return this.peopleService.list({
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
      entityType,
      userId: user.id,
    });
  }

  @Get('suggestions')
  async getSuggestions(@CurrentUser() user: { id: string }) {
    return this.peopleService.getSuggestions(user.id);
  }

  @RequiresJwt()
  @Post('auto-merge')
  async autoMerge() {
    return this.peopleService.autoMerge();
  }

  @RequiresJwt()
  @Post('reclassify')
  async reclassify() {
    return this.peopleService.reclassifyEntityTypes();
  }

  @RequiresJwt()
  @Post('backfill-avatars')
  async backfillAvatars() {
    return this.peopleService.backfillAvatarData();
  }

  @Get(':id/avatar')
  async getAvatar(
    @Param('id') id: string,
    @Query('index') indexStr: string | undefined,
    @CurrentUser() _user: { id: string },
    @Res() res: Response,
  ) {
    let contact: Awaited<ReturnType<typeof this.peopleService.getById>>;
    try {
      contact = await this.peopleService.getById(id);
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
        const buffer = Buffer.from(await upstream.arrayBuffer());

        // Cache as data URI in DB so subsequent requests serve from DB
        const dataUri = `data:${contentType};base64,${buffer.toString('base64')}`;
        const idx = allAvatars.indexOf(avatar);
        if (idx !== -1) {
          allAvatars[idx] = { url: dataUri, source: avatar.source };
          this.peopleService.updatePerson(id, { avatars: allAvatars }).catch(() => {}); // fire-and-forget
        }

        res.setHeader('Content-Type', contentType);
        res.setHeader('Cache-Control', 'public, max-age=86400');
        return res.send(buffer);
      } catch {
        continue;
      }
    }

    return res.status(HttpStatus.NOT_FOUND).json({ error: 'all avatars failed' });
  }

  @Get(':id')
  async getById(@Param('id') id: string) {
    return this.peopleService.getById(id);
  }

  @Get(':id/memories')
  async getMemories(@CurrentUser() user: { id: string }, @Param('id') id: string) {
    return this.peopleService.getMemories(id, undefined, user.id);
  }

  @RequiresJwt()
  @Patch(':id')
  async update(@Param('id') id: string, @Body() dto: UpdatePersonDto) {
    return this.peopleService.updatePerson(id, dto);
  }

  @RequiresJwt()
  @Delete(':id')
  async delete(@Param('id') id: string) {
    await this.peopleService.deletePerson(id);
    return { deleted: true };
  }

  @RequiresJwt()
  @Delete(':id/identifiers/:identId')
  async removeIdentifier(@Param('id') id: string, @Param('identId') identId: string) {
    return this.peopleService.removeIdentifier(id, identId);
  }

  @RequiresJwt()
  @Post(':id/split')
  async split(@Param('id') id: string, @Body() dto: SplitPersonDto) {
    return this.peopleService.splitPerson(id, dto.identifierIds);
  }

  @ReadOnly()
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @Post('search')
  async search(@Body() dto: SearchPeopleDto) {
    return this.peopleService.search(dto.query);
  }

  @RequiresJwt()
  @Post(':id/merge')
  async merge(@Param('id') id: string, @Body() dto: MergePersonDto) {
    return this.peopleService.mergePeople(id, dto.sourceId);
  }

  @RequiresJwt()
  @Post('normalize')
  async normalize() {
    return this.peopleService.normalizeAll();
  }

  @RequiresJwt()
  @Post('suggestions/dismiss')
  async dismissSuggestion(@Body() dto: DismissSuggestionDto) {
    await this.peopleService.dismissSuggestion(dto.contactId1, dto.contactId2);
    return { dismissed: true };
  }

  @RequiresJwt()
  @Post('suggestions/undismiss')
  async undismissSuggestion(@Body() dto: DismissSuggestionDto) {
    await this.peopleService.undismissSuggestion(dto.contactId1, dto.contactId2);
    return { undismissed: true };
  }
}
