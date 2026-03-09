import { Global, Module } from '@nestjs/common';
import { DbService } from './db.service';
import { RlsContext } from './rls.context';
import { RlsInterceptor } from './rls.interceptor';

@Global()
@Module({
  providers: [DbService, RlsContext, RlsInterceptor],
  exports: [DbService, RlsContext, RlsInterceptor],
})
export class DbModule {}
