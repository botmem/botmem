import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'async_hooks';

@Injectable()
export class RlsContext {
  private readonly storage = new AsyncLocalStorage<string>();

  /** Run fn with userId set as the current RLS context */
  run<T>(userId: string, fn: () => T): T {
    return this.storage.run(userId, fn);
  }

  /** Get current userId from AsyncLocalStorage — returns undefined outside a request */
  getCurrentUserId(): string | undefined {
    return this.storage.getStore();
  }
}
