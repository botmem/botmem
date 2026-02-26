import { Controller, Get } from '@nestjs/common';

const BUILD_TIME = new Date().toISOString();
let BUILD_HASH = 'unknown';

try {
  BUILD_HASH = require('child_process')
    .execSync('git rev-parse --short HEAD', { encoding: 'utf-8' })
    .trim();
} catch {}

@Controller('version')
export class VersionController {
  @Get()
  getVersion() {
    return {
      buildTime: BUILD_TIME,
      gitHash: BUILD_HASH,
      uptime: Math.floor(process.uptime()),
    };
  }
}
