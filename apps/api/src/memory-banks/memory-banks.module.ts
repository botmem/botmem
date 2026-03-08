import { Module, Global, forwardRef } from '@nestjs/common';
import { MemoryBanksService } from './memory-banks.service';
import { MemoryBanksController } from './memory-banks.controller';
import { MemoryModule } from '../memory/memory.module';

@Global()
@Module({
  imports: [forwardRef(() => MemoryModule)],
  controllers: [MemoryBanksController],
  providers: [MemoryBanksService],
  exports: [MemoryBanksService],
})
export class MemoryBanksModule {}
