import { describe, it, expect, vi } from 'vitest';
import { McpController } from '../mcp.controller';
import type { McpService } from '../mcp.service';
import type { McpAuthGuard } from '../mcp-auth.guard';

describe('McpController', () => {
  it('routes authenticated GET /mcp to the MCP service', async () => {
    const service = { handleSseStream: vi.fn() };
    const controller = new McpController(
      service as unknown as McpService,
      {
        validateRequest: vi.fn().mockReturnValue({ id: 'user-1', clientId: 'client-1' }),
      } as unknown as McpAuthGuard,
    );
    const req = { method: 'GET', originalUrl: '/mcp', headers: {} };

    await controller.handleGet(req as never, {} as never);

    expect(service.handleSseStream).toHaveBeenCalledWith(req, {}, 'user-1', 'client-1');
  });
});
