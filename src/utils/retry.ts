import { setTimeout } from 'node:timers/promises';
import { ProviderError } from '../providers/types.js';
export interface RetryOptions {
  maxRetries: number;
  retryBaseMs: number;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (attempt: number, ms: number) => void;
}
export async function retry<T>(operation: () => Promise<T>, options: RetryOptions): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    options.signal?.throwIfAborted();
    try { return await operation(); }
    catch (e) {
      options.signal?.throwIfAborted();
      if (!(e instanceof ProviderError) || !e.retryable || attempt >= options.maxRetries) throw e;
      const delay = Math.max(e.retryAfterMs, Math.min(60000, options.retryBaseMs * 2 ** attempt) * (0.5 + Math.random()));
      options.onRetry?.(attempt + 1, Math.ceil(delay));
      if (options.sleep) await options.sleep(delay);
      else await setTimeout(delay, undefined, { signal: options.signal });
    }
  }
}
