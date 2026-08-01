/**
 * Waiting for the worker to get somewhere.
 *
 * The worker is asynchronous and nothing in the framework is bounded by time
 * (ADR-0017), so a test asserts on a Signal's recorded state rather than on the
 * worker's internals. The deadline here is the test's own, not the framework's:
 * without one a broken worker hangs the suite instead of failing it.
 */

const defaultTimeoutMs = 10_000;
const pollIntervalMs = 5;

/**
 * Polls `condition` until it holds, or throws naming what never happened. The
 * description is the failure message, so write it as the thing that should have
 * been true.
 */
export async function waitUntil(
  description: string,
  condition: () => Promise<boolean>,
  timeoutMs: number = defaultTimeoutMs,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return;
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting until ${description}`);
    }
    await new Promise((resume) => setTimeout(resume, pollIntervalMs));
  }
}
