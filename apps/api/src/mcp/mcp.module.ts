import { Module, forwardRef } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { JwtModule } from '@nestjs/jwt';
import { McpController } from './mcp.controller';
import { McpService } from './mcp.service';
import { McpAuthGuard } from './mcp-auth.guard';
import { MemoryModule } from '../memory/memory.module';
import { AgentModule } from '../agent/agent.module';
import { AccountsModule } from '../accounts/accounts.module';

@Module({
  imports: [
    JwtModule.register({}),
    forwardRef(() => MemoryModule),
    AgentModule,
    AccountsModule,
    BullModule.registerQueue({ name: 'sync' }),
    BullModule.registerQueue({ name: 'memory' }),
    BullModule.registerQueue({ name: 'embed' }),
    BullModule.registerQueue({ name: 'enrich' }),
    BullModule.registerQueue({ name: 'maintenance' }),
    // DbModule and ConfigModule are @Global, no need to import
  ],
  controllers: [McpController],
  providers: [McpService, McpAuthGuard],
})
export class McpModule {}
