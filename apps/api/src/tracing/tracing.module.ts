import { Global, MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { TraceContext } from './trace.context';
import { TraceMiddleware } from './trace.middleware';

@Global()
@Module({
  providers: [TraceContext],
  exports: [TraceContext],
})
export class TracingModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(TraceMiddleware).forRoutes('*');
  }
}
