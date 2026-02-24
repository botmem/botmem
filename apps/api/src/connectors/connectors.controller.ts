import { Controller, Get, Param } from '@nestjs/common';
import { ConnectorsService } from './connectors.service';

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
}
