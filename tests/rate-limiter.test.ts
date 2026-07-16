import { describe, expect, test } from "bun:test";
import { RateLimiter } from "../src/rate-limiter";

describe("RateLimiter", () => {
  test("allows up to requests_per_minute requests immediately from a single client bucket", () => {
    const limiter = new RateLimiter({ enabled: true, requests_per_minute: 3 });
    const nowMs = 1_700_000_000_000;

    const first = limiter.check({
      nowMs,
      auth_enabled: false,
      req: new Request("http://localhost/"),
      server: { requestIP: () => ({ address: "203.0.113.10" }) },
    });
    const second = limiter.check({
      nowMs,
      auth_enabled: false,
      req: new Request("http://localhost/"),
      server: { requestIP: () => ({ address: "203.0.113.10" }) },
    });
    const third = limiter.check({
      nowMs,
      auth_enabled: false,
      req: new Request("http://localhost/"),
      server: { requestIP: () => ({ address: "203.0.113.10" }) },
    });

    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(true);
    expect(third.allowed).toBe(true);
  });

  test("rejects the request after bucket capacity is exhausted and rounds Retry-After up to whole seconds", () => {
    const limiter = new RateLimiter({ enabled: true, requests_per_minute: 3 });
    const nowMs = 1_700_000_000_000;
    const request = new Request("http://localhost/");
    const server = { requestIP: () => ({ address: "203.0.113.10" }) };

    limiter.check({ nowMs, auth_enabled: false, req: request, server });
    limiter.check({ nowMs, auth_enabled: false, req: request, server });
    limiter.check({ nowMs, auth_enabled: false, req: request, server });
    const rejected = limiter.check({ nowMs, auth_enabled: false, req: request, server });

    expect(rejected.allowed).toBe(false);
    expect(rejected.retryAfterSeconds).toBe(20);
    expect(rejected.headers["Retry-After"]).toBe("20");
  });

  test("refills tokens continuously at requests_per_minute / 60 tokens per second", () => {
    const limiter = new RateLimiter({ enabled: true, requests_per_minute: 60 });
    const request = new Request("http://localhost/");
    const server = { requestIP: () => ({ address: "203.0.113.10" }) };
    const startMs = 1_700_000_000_000;

    limiter.check({ nowMs: startMs, auth_enabled: false, req: request, server });
    const afterHalfSecond = limiter.check({
      nowMs: startMs + 500,
      auth_enabled: false,
      req: request,
      server,
    });

    expect(afterHalfSecond.allowed).toBe(true);
    expect(afterHalfSecond.headers["X-RateLimit-Remaining"]).toBe("58");
  });

  test("caps refilled tokens at the maximum capacity equal to requests_per_minute", () => {
    const limiter = new RateLimiter({ enabled: true, requests_per_minute: 2 });
    const request = new Request("http://localhost/");
    const server = { requestIP: () => ({ address: "203.0.113.10" }) };
    const startMs = 1_700_000_000_000;

    limiter.check({ nowMs: startMs, auth_enabled: false, req: request, server });
    const muchLater = limiter.check({
      nowMs: startMs + 120_000,
      auth_enabled: false,
      req: request,
      server,
    });

    expect(muchLater.allowed).toBe(true);
    expect(muchLater.headers["X-RateLimit-Limit"]).toBe("2");
    expect(muchLater.headers["X-RateLimit-Remaining"]).toBe("1");
  });

  test("uses Bearer token as the rate limiting identifier when auth_enabled is true", () => {
    const limiter = new RateLimiter({ enabled: true, requests_per_minute: 1 });
    const nowMs = 1_700_000_000_000;
    const sharedIpServer = { requestIP: () => ({ address: "203.0.113.10" }) };

    const tokenAFirst = limiter.check({
      nowMs,
      auth_enabled: true,
      req: new Request("http://localhost/", { headers: { authorization: "Bearer token-a" } }),
      server: sharedIpServer,
    });
    const tokenBFirst = limiter.check({
      nowMs,
      auth_enabled: true,
      req: new Request("http://localhost/", { headers: { authorization: "Bearer token-b" } }),
      server: sharedIpServer,
    });

    expect(tokenAFirst.allowed).toBe(true);
    expect(tokenBFirst.allowed).toBe(true);
  });

  test("uses server.requestIP(req)?.address as the identifier when auth_enabled is false", () => {
    const limiter = new RateLimiter({ enabled: true, requests_per_minute: 1 });
    const nowMs = 1_700_000_000_000;
    const requestA = new Request("http://localhost/");
    const requestB = new Request("http://localhost/");

    const firstIpA = limiter.check({
      nowMs,
      auth_enabled: false,
      req: requestA,
      server: { requestIP: () => ({ address: "203.0.113.10" }) },
    });
    const firstIpB = limiter.check({
      nowMs,
      auth_enabled: false,
      req: requestB,
      server: { requestIP: () => ({ address: "203.0.113.11" }) },
    });

    expect(firstIpA.allowed).toBe(true);
    expect(firstIpB.allowed).toBe(true);
  });

  test("falls back to X-Forwarded-For when server.requestIP(req) is unavailable", () => {
    const limiter = new RateLimiter({ enabled: true, requests_per_minute: 1 });
    const nowMs = 1_700_000_000_000;

    const first = limiter.check({
      nowMs,
      auth_enabled: false,
      req: new Request("http://localhost/", { headers: { "x-forwarded-for": "198.51.100.42, 10.0.0.1" } }),
      server: { requestIP: () => null },
    });
    const second = limiter.check({
      nowMs,
      auth_enabled: false,
      req: new Request("http://localhost/", { headers: { "x-forwarded-for": "198.51.100.42, 10.0.0.2" } }),
      server: { requestIP: () => null },
    });

    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(false);
  });

  test("falls back to 127.0.0.1 when neither requestIP nor X-Forwarded-For are available", () => {
    const limiter = new RateLimiter({ enabled: true, requests_per_minute: 1 });
    const nowMs = 1_700_000_000_000;

    const first = limiter.check({
      nowMs,
      auth_enabled: false,
      req: new Request("http://localhost/"),
      server: { requestIP: () => null },
    });
    const second = limiter.check({
      nowMs,
      auth_enabled: false,
      req: new Request("http://localhost/"),
      server: { requestIP: () => null },
    });

    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(false);
  });

  test("returns rate limit headers on allowed responses", () => {
    const limiter = new RateLimiter({ enabled: true, requests_per_minute: 60 });

    const result = limiter.check({
      nowMs: 1_700_000_000_000,
      auth_enabled: false,
      req: new Request("http://localhost/"),
      server: { requestIP: () => ({ address: "203.0.113.10" }) },
    });

    expect(result.headers["X-RateLimit-Limit"]).toBe("60");
    expect(result.headers["X-RateLimit-Remaining"]).toBe("59");
    expect(result.headers["X-RateLimit-Reset"]).toBe("1700000001");
  });
});
