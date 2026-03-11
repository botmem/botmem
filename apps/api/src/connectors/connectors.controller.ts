import { Controller, Get, Param } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ConnectorsService } from './connectors.service';

@ApiTags('Connectors')
@ApiBearerAuth()
@Controller('connectors')
export class ConnectorsController {
  constructor(private connectors: ConnectorsService) {}

  @Get()
  list() {
    return { connectors: this.connectors.list() };
  }

  @Get(':type/schema')
  getSchema(@Param('type') type: string) {
    return { schema: this.connectors.getSchema(type) };
  }

  @Get(':type/status')
  getStatus(@Param('type') type: string) {
    const connector = this.connectors.get(type);
    const conn = connector as unknown as Record<string, unknown>;
    if (typeof conn.getStatus === 'function') {
      return (conn.getStatus as () => unknown)();
    }
    return { ready: true, status: 'available' };
  }
}
