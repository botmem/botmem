import { Injectable, NestMiddleware } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import { trace } from '@opentelemetry/api';
import { TraceContext, generateTraceId, generateSpanId } from './trace.context';

@Injectable()
export class TraceMiddleware implements NestMiddleware {
  constructor(private traceContext: TraceContext) {}

  use(req: Request, res: Response, next: NextFunction) {
    // Prefer OTel span context if available (auto-instrumented by OTel HTTP)
    const otelSpan = trace.getActiveSpan();
    const otelCtx = otelSpan?.spanContext();

    const traceId = otelCtx?.traceId || generateTraceId();
    const spanId = otelCtx?.spanId || generateSpanId();

    res.setHeader('x-trace-id', traceId);

    this.traceContext.run({ traceId, spanId }, () => next());
  }
}
