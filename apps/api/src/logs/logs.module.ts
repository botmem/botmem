import { Global, Module } from '@nestjs/common';
import { LogsService } from './logs.service';

@Global()
@Module({
  providers: [LogsService],
  exports: [LogsService],
})
export class LogsModule {}
