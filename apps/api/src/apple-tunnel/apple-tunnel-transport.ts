/**
 * WebSocket tunnel transport for the iMessage connector.
 *
 * Server-side only — delegates RPC calls through the AppleTunnelService
 * to a remote bridge connected via encrypted WebSocket.
 */

import type { AppleTunnelService } from './apple-tunnel.service';

/** Matches RpcTransport from @botmem/connector-imessage */
interface RpcTransport {
  connect(): Promise<void>;
  disconnect(): void;
  call(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

export class AppleTunnelTransport implements RpcTransport {
  constructor(
    private tunnelService: AppleTunnelService,
    private accountId: string,
  ) {}

  async connect(): Promise<void> {
    if (!(await this.tunnelService.hasConnectedBridge(this.accountId))) {
      throw new Error(
        'Apple bridge is not connected. Ask the user to run the bridge on their Mac.',
      );
    }
  }

  disconnect(): void {
    // No-op — tunnel lifecycle is managed by AppleTunnelService
  }

  async call(method: string, params?: Record<string, unknown>): Promise<unknown> {
    return this.tunnelService.sendRpcRequest(this.accountId, method, params);
  }
}
