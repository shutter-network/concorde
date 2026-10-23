const defaultTimeoutMs = 10_000;
const pollIntervalMs = 5;

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
