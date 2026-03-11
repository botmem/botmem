import { Catch, ArgumentsHost, HttpException, HttpStatus } from '@nestjs/common';
import { BaseExceptionFilter, HttpAdapterHost } from '@nestjs/core';
import { AnalyticsService } from './analytics.service';

@Catch()
export class PostHogExceptionFilter extends BaseExceptionFilter {
  private readonly analytics: AnalyticsService;

  constructor(analytics: AnalyticsService, httpAdapterHost: HttpAdapterHost) {
    super(httpAdapterHost.httpAdapter);
    this.analytics = analytics;
  }

  catch(exception: unknown, host: ArgumentsHost) {
    const status =
      exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;

    // Only capture 5xx errors (not 4xx client errors like 404)
    if (status >= 500) {
      const message = exception instanceof Error ? exception.message : String(exception);
      const stack = exception instanceof Error ? exception.stack : undefined;

      this.analytics.capture('$exception', {
        $exception_message: message,
        $exception_type: exception?.constructor?.name || 'UnknownError',
        $exception_stack_trace_raw: stack,
        $exception_source: 'backend',
        http_status: status,
      });
    }

    // For HttpExceptions, delegate to NestJS default handler (safe serialization).
    // For unknown errors (which may contain circular refs like Socket objects),
    // send a plain response to avoid "Converting circular structure to JSON".
    const ctx = host.switchToHttp();
    const response = ctx.getResponse();

    // Don't attempt to send if headers already sent (e.g. streaming/redirect responses)
    if (response.headersSent) return;

    if (exception instanceof HttpException) {
      super.catch(exception, host);
    } else {
      // Non-HttpException errors may contain circular refs (Socket objects etc.)
      // Send a plain response to avoid "Converting circular structure to JSON"
      const message = exception instanceof Error ? exception.message : 'Internal server error';
      response.status(status).json({
        statusCode: status,
        message,
      });
    }
  }
}
