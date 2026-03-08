import { Global, Module } from '@nestjs/common';
import { DbModule } from '../db/db.module';
import { ApiKeysService } from './api-keys.service';
import { ApiKeysController } from './api-keys.controller';

@Global()
@Module({
  imports: [DbModule],
  providers: [ApiKeysService],
  exports: [ApiKeysService],
  controllers: [ApiKeysController],
})
export class ApiKeysModule {}
