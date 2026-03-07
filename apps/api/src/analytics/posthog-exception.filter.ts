import { Catch, ArgumentsHost, HttpException, HttpStatus } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { AnalyticsService } from './analytics.service';

@Catch()
export class PostHogExceptionFilter extends BaseExceptionFilter {
  constructor(private readonly analytics: AnalyticsService) {
    super();
  }

  catch(exception: unknown, host: ArgumentsHost) {
    // Send to PostHog before delegating to default handler
    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    // Only capture 5xx errors (not 4xx client errors like 404)
    if (status >= 500) {
      const message =
        exception instanceof Error ? exception.message : String(exception);
      const stack =
        exception instanceof Error ? exception.stack : undefined;

      this.analytics.capture('$exception', {
        $exception_message: message,
        $exception_type: exception?.constructor?.name || 'UnknownError',
        $exception_stack_trace_raw: stack,
        $exception_source: 'backend',
        http_status: status,
      });
    }

    // Delegate to NestJS default exception handling (sends HTTP response)
    super.catch(exception, host);
  }
}
