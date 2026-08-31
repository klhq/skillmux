import { describe, expect, test } from "bun:test";
import { ConcurrencyLimiter, releaseOnStreamClose } from "../src/concurrency-limiter";

describe("ConcurrencyLimiter", () => {
  test("allows acquiring up to max in-flight requests", () => {
    const limiter = new ConcurrencyLimiter(2);
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(true);
  });

  test("rejects an additional acquire once max in-flight requests are held", () => {
    const limiter = new ConcurrencyLimiter(2);
    limiter.tryAcquire();
    limiter.tryAcquire();
    expect(limiter.tryAcquire()).toBe(false);
  });

  test("allows a new acquire after a release frees a slot", () => {
    const limiter = new ConcurrencyLimiter(1);
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(false);
    limiter.release();
    expect(limiter.tryAcquire()).toBe(true);
  });

  test("a limiter constructed with max 0 rejects every acquire", () => {
    const limiter = new ConcurrencyLimiter(0);
    expect(limiter.tryAcquire()).toBe(false);
  });
});

describe("releaseOnStreamClose", () => {
  test("releases immediately when the response has no body", () => {
    let released = false;
    const wrapped = releaseOnStreamClose(null, () => {
      released = true;
    });
    expect(wrapped).toBeNull();
    expect(released).toBe(true);
  });

  test("does not release before the wrapped stream is fully consumed", async () => {
    let released = false;
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("chunk"));
        // deliberately left open — simulates an in-progress SSE stream
      },
    });
    const wrapped = releaseOnStreamClose(source, () => {
      released = true;
    });
    const reader = wrapped!.getReader();
    await reader.read();
    expect(released).toBe(false);
  });

  test("releases once the wrapped stream is fully drained", async () => {
    let released = false;
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("chunk"));
        controller.close();
      },
    });
    const wrapped = releaseOnStreamClose(source, () => {
      released = true;
    });
    const reader = wrapped!.getReader();
    await reader.read();
    expect(released).toBe(false);
    await reader.read();
    expect(released).toBe(true);
  });

  test("releases when the wrapped stream is cancelled before it closes", async () => {
    let released = false;
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("chunk"));
        // never closes — simulates an open SSE stream the client disconnects from
      },
    });
    const wrapped = releaseOnStreamClose(source, () => {
      released = true;
    });
    await wrapped!.cancel("client disconnected");
    expect(released).toBe(true);
  });

  test("releases at most once even if drain and cancel both occur", async () => {
    let releaseCount = 0;
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });
    const wrapped = releaseOnStreamClose(source, () => {
      releaseCount++;
    });
    const reader = wrapped!.getReader();
    await reader.read();
    await wrapped!.cancel().catch(() => {});
    expect(releaseCount).toBe(1);
  });
});
