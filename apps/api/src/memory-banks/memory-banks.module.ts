import { Module, Global } from '@nestjs/common';
import { MemoryBanksService } from './memory-banks.service';
import { MemoryBanksController } from './memory-banks.controller';

@Global()
@Module({
  controllers: [MemoryBanksController],
  providers: [MemoryBanksService],
  exports: [MemoryBanksService],
})
export class MemoryBanksModule {}
