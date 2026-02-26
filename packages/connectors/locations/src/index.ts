import { BaseConnector } from '@botmem/connector-sdk';
import type { ConnectorManifest, AuthContext, AuthInitResult, SyncContext, SyncResult } from '@botmem/connector-sdk';
import { OwnTracksClient } from './owntracks.js';
import { syncLocations } from './sync.js';

export class LocationsConnector extends BaseConnector {
  readonly manifest: ConnectorManifest = {
    id: 'locations',
    name: 'Locations (OwnTracks)',
    description: 'Import location history from OwnTracks Recorder',
    color: '#4CAF50',
    icon: 'map-pin',
    authType: 'api-key',
    configSchema: {
      type: 'object',
      properties: {
        host: {
          type: 'string',
          title: 'OwnTracks Recorder URL',
          description: 'e.g. http://localhost:8083',
        },
        user: {
          type: 'string',
          title: 'User',
          description: 'OwnTracks user to sync (leave empty for all users)',
        },
        device: {
          type: 'string',
          title: 'Device',
          description: 'OwnTracks device to sync (leave empty for all devices)',
        },
        username: {
          type: 'string',
          title: 'HTTP Username',
          description: 'Basic auth username (if Recorder is behind a proxy)',
        },
        password: {
          type: 'string',
          title: 'HTTP Password',
          description: 'Basic auth password (if Recorder is behind a proxy)',
        },
      },
      required: ['host'],
    },
  };

  async initiateAuth(config: Record<string, unknown>): Promise<AuthInitResult> {
    const host = (config.host as string).replace(/\/+$/, '');
    const username = (config.username as string | undefined) || (config.user as string | undefined);
    const password = config.password as string | undefined;
    const user = config.user as string | undefined;
    const device = config.device as string | undefined;

    const client = new OwnTracksClient(host, username, password);
    const version = await client.getVersion();

    const identifier = user
      ? `${user}${device ? '/' + device : ''} @ ${host}`
      : host;

    return {
      type: 'complete',
      auth: {
        identifier,
        raw: { host, username, password, user, device, version: version.version },
      },
    };
  }

  async completeAuth(params: Record<string, unknown>): Promise<AuthContext> {
    return {
      raw: {
        host: params.host,
        username: params.username,
        password: params.password,
        user: params.user,
        device: params.device,
      },
    };
  }

  async validateAuth(auth: AuthContext): Promise<boolean> {
    const host = auth.raw?.host as string;
    const username = auth.raw?.username as string | undefined;
    const password = auth.raw?.password as string | undefined;
    try {
      const client = new OwnTracksClient(host, username, password);
      await client.getVersion();
      return true;
    } catch {
      return false;
    }
  }

  async revokeAuth(): Promise<void> {
    // No credentials to revoke
  }

  async sync(ctx: SyncContext): Promise<SyncResult> {
    return syncLocations(
      ctx,
      (event) => this.emitData(event),
      (p) => this.emit('progress', p),
    );
  }
}

export default () => new LocationsConnector();
