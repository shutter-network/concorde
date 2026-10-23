export const firstDelayMs = 250;

export const maxDelayMs = 5000;

export function backoffFor(attempt: number): number {
  return Math.min(firstDelayMs * 2 ** (attempt - 1), maxDelayMs);
}

export type RetryOptions = {
  readonly retryable: (error: unknown) => boolean;
  readonly sleep: (ms: number) => Promise<void>;
  readonly waiting?: (error: unknown, attempt: number, delayMs: number) => void;
};

export async function retrying<T>(attempt: () => Promise<T>, options: RetryOptions): Promise<T> {
  for (let attempted = 1; ; attempted += 1) {
    try {
      return await attempt();
    } catch (error) {
      if (!options.retryable(error)) throw error;
      const delayMs = backoffFor(attempted);
      options.waiting?.(error, attempted, delayMs);
      await options.sleep(delayMs);
    }
  }
}
