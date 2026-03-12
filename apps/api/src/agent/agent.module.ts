import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module';
import { MemoryModule } from '../memory/memory.module';
import { PeopleModule } from '../people/people.module';
import { ConfigModule } from '../config/config.module';
import { AgentController } from './agent.controller';
import { AgentService } from './agent.service';

@Module({
  imports: [DbModule, MemoryModule, PeopleModule, ConfigModule],
  controllers: [AgentController],
  providers: [AgentService],
  exports: [AgentService],
})
export class AgentModule {}
