import { describe, expect, test } from "bun:test";
import { ConcurrencyLimiter } from "../src/concurrency-limiter";

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
