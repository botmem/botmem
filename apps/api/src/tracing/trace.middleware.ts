import { Injectable, NestMiddleware } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import { TraceContext, generateTraceId, generateSpanId } from './trace.context';

@Injectable()
export class TraceMiddleware implements NestMiddleware {
  constructor(private traceContext: TraceContext) {}

  use(req: Request, res: Response, next: NextFunction) {
    const traceId = generateTraceId();
    const spanId = generateSpanId();

    res.setHeader('x-trace-id', traceId);

    this.traceContext.run({ traceId, spanId }, () => next());
  }
}
