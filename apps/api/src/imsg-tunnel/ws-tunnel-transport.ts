/**
 * WebSocket tunnel transport for the iMessage connector.
 *
 * Server-side only — delegates RPC calls through the ImsgTunnelService
 * to a remote bridge connected via encrypted WebSocket.
 */

import type { ImsgTunnelService } from './imsg-tunnel.service';

/** Matches RpcTransport from @botmem/connector-imessage */
interface RpcTransport {
  connect(): Promise<void>;
  disconnect(): void;
  call(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

export class WsTunnelTransport implements RpcTransport {
  constructor(
    private tunnelService: ImsgTunnelService,
    private accountId: string,
  ) {}

  async connect(): Promise<void> {
    if (!this.tunnelService.isConnected(this.accountId)) {
      throw new Error(
        'iMessage bridge is not connected. Ask the user to run the bridge on their Mac.',
      );
    }
  }

  disconnect(): void {
    // No-op — tunnel lifecycle is managed by ImsgTunnelService
  }

  async call(method: string, params?: Record<string, unknown>): Promise<unknown> {
    return this.tunnelService.sendRpcRequest(this.accountId, method, params);
  }
}
