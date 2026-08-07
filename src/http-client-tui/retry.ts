/**
 * The one thing Compose cannot express: wait until the Gateway is listening.
 *
 * A `depends_on` waits for a container and not for a socket, so the first request of a client
 * started beside its Gateway is refused. That refusal is the normal case here rather than a
 * failure, which is why it is retried without a bound: the reader stops the client when they have
 * waited long enough, and a client that gave up after ten seconds would have to be started again
 * by hand for no reason.
 *
 * What is **not** retried is anything the Gateway answered. A 401 is a wrong password and a 400 is
 * a malformed request, and both are answered identically a second time. So the predicate is
 * positive: the caller names the error that means "no answer arrived", and everything else, a bug
 * in this client included, leaves through the first throw.
 *
 * `sleep` is a parameter for two reasons. A test states the delays instead of waiting them out,
 * and the running client passes a sleep that its shutdown signal aborts, so Ctrl-C during a wait
 * ends the wait rather than being noticed a second later.
 */

/** How long the first wait is. */
export const firstDelayMs = 250;

/** The longest any wait gets. A client waiting for a Gateway should notice it inside five seconds. */
export const maxDelayMs = 5000;

/**
 * How long to wait before attempt `attempt + 1`, doubling from {@link firstDelayMs} to the cap.
 *
 * Attempts are counted from 1, so the wait after the first failure is the first delay.
 */
export function backoffFor(attempt: number): number {
  return Math.min(firstDelayMs * 2 ** (attempt - 1), maxDelayMs);
}

export type RetryOptions = {
  /** True for the errors that mean no answer arrived. Every other error is thrown at once. */
  readonly retryable: (error: unknown) => boolean;
  /** Waits, and rejects if the client is shutting down. */
  readonly sleep: (ms: number) => Promise<void>;
  /** Called before each wait, with the attempt that just failed. Print from here, not from a loop. */
  readonly waiting?: (error: unknown, attempt: number, delayMs: number) => void;
};

/**
 * Runs `attempt` until it answers, waiting longer between each retryable failure.
 *
 * It has no attempt limit. The loop ends when the attempt succeeds, when it fails in a way
 * `retryable` rejects, or when `sleep` rejects because the client is shutting down.
 */
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
