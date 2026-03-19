import {
  Global,
  Logger,
  MiddlewareConsumer,
  Module,
  NestModule,
  OnModuleInit,
} from '@nestjs/common';
import { TraceContext } from './trace.context';
import { TraceMiddleware } from './trace.middleware';

@Global()
@Module({
  providers: [TraceContext],
  exports: [TraceContext],
})
export class TracingModule implements NestModule, OnModuleInit {
  private readonly logger = new Logger(TracingModule.name);

  onModuleInit() {
    const otelEnabled = process.env.OTEL_ENABLED === 'true';
    if (otelEnabled) {
      this.logger.log('OpenTelemetry tracing is active');
    }
  }

  configure(consumer: MiddlewareConsumer) {
    consumer.apply(TraceMiddleware).forRoutes('*');
  }
}
