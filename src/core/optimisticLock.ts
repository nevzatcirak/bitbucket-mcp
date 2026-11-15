/**
 * Optimistic-locking retry wrapper.
 *
 * Some Bitbucket Server write endpoints carry a `version` field in the
 * resource; concurrent writers cause HTTP 409 conflicts. This wrapper
 * re-fetches the current resource, applies the mutation against the fresh
 * version and retries exactly once (default) before giving up.
 */

import { RestError } from "./restClient.js";

export interface OptimisticLockOptions<T> {
  /** Fetch the current resource, including its `version`. */
  fetchCurrent: () => Promise<Record<string, unknown> & { version: number }>;
  /** Apply the write against the (fresh) current resource. */
  apply: (current: Record<string, unknown> & { version: number }) => Promise<T>;
  /** How many retries after the first conflict. Default: 1. */
  maxRetries?: number;
  /** Observability hook: called before each retry attempt. */
  onRetry?: (attempt: number, error: RestError) => void;
}

export async function withOptimisticLock<T>(options: OptimisticLockOptions<T>): Promise<T> {
  const maxRetries = options.maxRetries ?? 1;
  let current = await options.fetchCurrent();

  for (let attempt = 0; ; attempt++) {
    try {
      return await options.apply(current);
    } catch (err) {
      const isConflict = err instanceof RestError && err.status === 409;
      if (!isConflict || attempt >= maxRetries) throw err;
      options.onRetry?.(attempt + 1, err);
      current = await options.fetchCurrent();
    }
  }
}
