import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../user-auth/decorators/current-user.decorator';
import { ConfigService } from '../config/config.service';
import { AppleTunnelService } from '../apple-tunnel/apple-tunnel.service';

export interface BridgeStatusResponse {
  online: boolean;
  flagEnabled: boolean;
  sources?: Array<{ source: string; count: number; lastIndexedAt: string | null }>;
}

/**
 * Live Bridge status. Reports whether the user's local Mac bridge is connected
 * and, when online, the live source/index summary fetched from the bridge.
 * Nothing is persisted.
 */
@ApiTags('Bridge')
@ApiBearerAuth()
@Controller('bridge')
export class BridgeController {
  constructor(
    private readonly config: ConfigService,
    private readonly appleTunnel: AppleTunnelService,
  ) {}

  @Get('status')
  async getStatus(@CurrentUser() user: { id: string }): Promise<BridgeStatusResponse> {
    const flagEnabled = this.config.bridgeLiveSearch;
    const online = this.appleTunnel.isBridgeOnlineForUser(user.id);

    if (!online) {
      return { online: false, flagEnabled };
    }

    // online → fetch live source summary via the bridge.status RPC
    const status = await this.appleTunnel.bridgeStatusForUser(user.id);
    return {
      online: true,
      flagEnabled,
      sources: status?.sources ?? [],
    };
  }
}
