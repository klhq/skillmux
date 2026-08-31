export class ConcurrencyLimiter {
  private inFlight = 0;

  constructor(private readonly max: number) {}

  tryAcquire(): boolean {
    if (this.inFlight >= this.max) return false;
    this.inFlight++;
    return true;
  }

  release(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
  }
}

/**
 * Wraps a response body so `release` fires when the stream actually finishes
 * (fully drained or cancelled by a client disconnect) instead of as soon as
 * the Response object is constructed. For a buffered body this happens almost
 * immediately; for an open SSE stream it defers release until the connection
 * really closes, so a concurrency limiter reflects true connection lifetime.
 */
export function releaseOnStreamClose(
  body: ReadableStream<Uint8Array> | null,
  release: () => void,
): ReadableStream<Uint8Array> | null {
  if (!body) {
    release();
    return null;
  }

  const reader = body.getReader();
  let released = false;
  const releaseOnce = () => {
    if (released) return;
    released = true;
    release();
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          releaseOnce();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        controller.error(error);
        releaseOnce();
      }
    },
    cancel(reason) {
      releaseOnce();
      return reader.cancel(reason);
    },
  });
}
