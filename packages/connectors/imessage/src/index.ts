import { BaseConnector } from '@botmem/connector-sdk';
import type { ConnectorManifest, AuthContext, AuthInitResult, SyncContext, SyncResult } from '@botmem/connector-sdk';
import { checkExporter, exportMessages } from './exporter.js';

export class IMessageConnector extends BaseConnector {
  readonly manifest: ConnectorManifest = {
    id: 'imessage',
    name: 'iMessage',
    description: 'Import iMessage conversations (macOS only)',
    color: '#4ECDC4',
    icon: 'smartphone',
    authType: 'local-tool',
    configSchema: {
      type: 'object',
      properties: {
        note: {
          type: 'string',
          title: 'Requirements',
          description: 'Requires imessage-exporter CLI tool. Install via: brew install imessage-exporter',
          readOnly: true,
        },
      },
    },
  };

  async initiateAuth(_config: Record<string, unknown>): Promise<AuthInitResult> {
    const available = await checkExporter();
    if (!available) {
      throw new Error('imessage-exporter not found. Install via: brew install imessage-exporter');
    }
    return { type: 'complete', auth: { raw: { tool: 'imessage-exporter' } } };
  }

  async completeAuth(_params: Record<string, unknown>): Promise<AuthContext> {
    return { raw: { tool: 'imessage-exporter' } };
  }

  async validateAuth(_auth: AuthContext): Promise<boolean> {
    return checkExporter();
  }

  async revokeAuth(): Promise<void> {
    // Nothing to revoke
  }

  async sync(ctx: SyncContext): Promise<SyncResult> {
    ctx.logger.info('Starting iMessage export');
    const processed = await exportMessages(ctx.signal, (event) => this.emit('data', event));
    this.emit('progress', { processed });
    ctx.logger.info(`Exported ${processed} iMessages`);
    return { cursor: null, hasMore: false, processed };
  }
}

export default () => new IMessageConnector();
