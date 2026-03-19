import { trace, SpanStatusCode, type Span } from '@opentelemetry/api';

const tracer = trace.getTracer('botmem-api');

/**
 * Method decorator that wraps the method in an OTel span.
 *
 * Usage:
 *   @Traced('sync.process')
 *   async process(job: Job) { ... }
 *
 * The span name defaults to `ClassName.methodName` if not provided.
 * Attributes can be extracted from method args via the `attrs` option.
 */
export function Traced(
  spanName?: string,
  opts?: { attrs?: Record<string, string | number | boolean> },
): MethodDecorator {
  return function (_target, propertyKey, descriptor: PropertyDescriptor) {
    const original = descriptor.value;
    const name = spanName || `${_target.constructor.name}.${String(propertyKey)}`;

    descriptor.value = function (...args: unknown[]) {
      return tracer.startActiveSpan(name, (span: Span) => {
        if (opts?.attrs) {
          span.setAttributes(opts.attrs);
        }

        try {
          const result = original.apply(this, args);

          // Handle async methods
          if (result instanceof Promise) {
            return result
              .then((val: unknown) => {
                span.setStatus({ code: SpanStatusCode.OK });
                span.end();
                return val;
              })
              .catch((err: Error) => {
                span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
                span.recordException(err);
                span.end();
                throw err;
              });
          }

          span.setStatus({ code: SpanStatusCode.OK });
          span.end();
          return result;
        } catch (err) {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: (err as Error).message,
          });
          span.recordException(err as Error);
          span.end();
          throw err;
        }
      });
    };

    return descriptor;
  };
}

/** Create a manual span for wrapping arbitrary code blocks */
export function startSpan(name: string, attrs?: Record<string, string | number | boolean>) {
  const span = tracer.startSpan(name);
  if (attrs) span.setAttributes(attrs);
  return span;
}

export { tracer };
