import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from './user-auth/decorators/public.decorator';
import { ConfigService } from './config/config.service';

const BUILD_TIME = new Date().toISOString();
let BUILD_HASH = 'unknown';

try {
  BUILD_HASH = require('child_process')
    .execSync('git rev-parse --short HEAD', { encoding: 'utf-8' })
    .trim();
} catch {
  /* empty */
}

@ApiTags('System')
@Public()
@Controller('version')
export class VersionController {
  constructor(private config: ConfigService) {}

  @Get()
  getVersion() {
    return {
      buildTime: BUILD_TIME,
      gitHash: BUILD_HASH,
      uptime: Math.floor(process.uptime()),
      authProvider: this.config.authProvider,
    };
  }
}
