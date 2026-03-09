import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import { Observable } from 'rxjs';
import { RlsContext } from './rls.context';

@Injectable()
export class RlsInterceptor implements NestInterceptor {
  constructor(private readonly rlsContext: RlsContext) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const request = context.switchToHttp().getRequest();
    const userId: string | undefined = request.user?.id;

    // Public routes or unauthenticated — do not set RLS context
    if (!userId) {
      return next.handle();
    }

    // Run the rest of the request lifecycle inside the AsyncLocalStorage context.
    // AsyncLocalStorage.run() propagates the value through all async continuations
    // (awaits, Promise chains, callbacks) in the same async tree — so every
    // Drizzle query triggered by this request sees the correct userId via
    // dbService.withCurrentUser().
    return new Observable((subscriber) => {
      this.rlsContext.run(userId, () => {
        next.handle().subscribe({
          next: (val) => subscriber.next(val),
          error: (err) => subscriber.error(err),
          complete: () => subscriber.complete(),
        });
      });
    });
  }
}
