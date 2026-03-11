import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module';
import { CryptoModule } from '../crypto/crypto.module';
import { MemoryModule } from '../memory/memory.module';
import { ConfigModule } from '../config/config.module';
import { DemoController } from './demo.controller';
import { DemoService } from './demo.service';

@Module({
  imports: [DbModule, CryptoModule, MemoryModule, ConfigModule],
  controllers: [DemoController],
  providers: [DemoService],
  exports: [DemoService],
})
export class DemoModule {}
