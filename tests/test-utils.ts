/**
 * Shared test polling helper for watcher and asynchronous state condition assertion.
 * Repeats checking `condition` until it returns true or until `timeoutMs` elapses.
 */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
  pollIntervalMs = 25,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await condition()) return;
    } catch {
      // Ignore evaluation errors during polling until deadline
    }
    await Bun.sleep(pollIntervalMs);
  }
  throw new Error(`condition was not met within ${timeoutMs}ms`);
}

/**
 * Asserts that a condition remains false for a specified duration (`waitMs`).
 * Useful for verifying that no callback or side-effect fires after shutdown or invalid events.
 */
export async function assertRemainsFalse(
  condition: () => boolean | Promise<boolean>,
  waitMs = 300,
  pollIntervalMs = 25,
): Promise<void> {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (await condition()) {
      throw new Error(`condition became true unexpectedly within ${waitMs}ms`);
    }
    await Bun.sleep(pollIntervalMs);
  }
}
