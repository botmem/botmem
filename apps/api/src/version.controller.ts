import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from './user-auth/decorators/public.decorator';
import { ConfigService } from './config/config.service';

const BUILD_TIME = new Date().toISOString();

export interface VersionInfo {
  buildTime: string;
  uptime: number;
  authProvider: string;
  version?: string;
  gitHash?: string;
}

export function resolveBuildMetadata(env: NodeJS.ProcessEnv = process.env): {
  version?: string;
  gitHash?: string;
} {
  const version = env.BOTMEM_BUILD_VERSION?.trim() || undefined;
  const envHash = env.BOTMEM_BUILD_SHA?.trim() || env.GITHUB_SHA?.trim() || undefined;
  const gitHash = envHash ? envHash.slice(0, 12) : readLocalGitHash();

  return {
    ...(version ? { version } : {}),
    ...(gitHash ? { gitHash } : {}),
  };
}

function readLocalGitHash(): string | undefined {
  try {
    return require('child_process')
      .execSync('git rev-parse --short=12 HEAD', { encoding: 'utf-8' })
      .trim();
  } catch {
    return undefined;
  }
}

const BUILD_METADATA = resolveBuildMetadata();

@ApiTags('System')
@Public()
@Controller('version')
export class VersionController {
  constructor(private config: ConfigService) {}

  @Get()
  getVersion(): VersionInfo {
    return {
      buildTime: BUILD_TIME,
      ...BUILD_METADATA,
      uptime: Math.floor(process.uptime()),
      authProvider: this.config.authProvider,
    };
  }
}
