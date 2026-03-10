import { Module, forwardRef } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { McpController } from './mcp.controller';
import { McpService } from './mcp.service';
import { McpAuthGuard } from './mcp-auth.guard';
import { MemoryModule } from '../memory/memory.module';
import { AgentModule } from '../agent/agent.module';

@Module({
  imports: [
    JwtModule.register({}),
    forwardRef(() => MemoryModule),
    AgentModule,
    // DbModule and ConfigModule are @Global, no need to import
  ],
  controllers: [McpController],
  providers: [McpService, McpAuthGuard],
})
export class McpModule {}
