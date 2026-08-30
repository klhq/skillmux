interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

// SMX-93: bounds memory even when an attacker (behind a trust_proxy-honored
// reverse proxy) mints unbounded distinct X-Forwarded-For values, or a
// long-running deployment simply accumulates many distinct legitimate
// clients over time. Past this many entries, the least-recently-used
// bucket is evicted to make room — active clients are never evicted ahead
// of idle ones.
const DEFAULT_MAX_BUCKETS = 10_000;

export interface RateLimitCheckInput {
  nowMs: number;
  auth_enabled: boolean;
  req: Request;
  server: {
    requestIP(request: Request): { address: string } | null;
  };
}

export interface RateLimitCheckResult {
  allowed: boolean;
  retryAfterSeconds?: number;
  headers: Record<string, string>;
}

export class RateLimiter {
  private enabled: boolean;
  private requests_per_minute: number;
  private trust_proxy: boolean;
  private max_buckets: number;
  private buckets = new Map<string, Bucket>();

  constructor(config: {
    enabled: boolean;
    requests_per_minute: number;
    trust_proxy?: boolean;
    max_buckets?: number;
  }) {
    this.enabled = config.enabled;
    this.requests_per_minute = config.requests_per_minute;
    this.trust_proxy = config.trust_proxy ?? false;
    this.max_buckets = config.max_buckets ?? DEFAULT_MAX_BUCKETS;
  }

  check(input: RateLimitCheckInput): RateLimitCheckResult {
    if (!this.enabled) {
      return { allowed: true, headers: {} };
    }

    // 1. Resolve identifier
    let id = "127.0.0.1";
    if (input.auth_enabled) {
      const authHeader = input.req.headers.get("authorization") || "";
      const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : authHeader;
      if (token) {
        id = token;
      }
    } else {
      const ipAddr = input.server.requestIP(input.req)?.address;
      if (ipAddr) {
        id = ipAddr;
      } else if (this.trust_proxy) {
        // X-Forwarded-For is client-supplied and spoofable; only honor it
        // when trust_proxy opts in (i.e. a trusted reverse proxy sets it).
        const xff = input.req.headers.get("x-forwarded-for");
        if (xff) {
          id = xff.split(",", 1)[0]?.trim() || id;
        }
      }
    }

    // 2. Retrieve or initialize bucket
    let bucket = this.buckets.get(id);
    if (bucket) {
      // Map iteration order is insertion order, so re-inserting on touch
      // marks this entry as most-recently-used and moves it out of the
      // eviction path below.
      this.buckets.delete(id);
      this.buckets.set(id, bucket);
    } else {
      if (this.buckets.size >= this.max_buckets) {
        const oldestId = this.buckets.keys().next().value;
        if (oldestId !== undefined) {
          this.buckets.delete(oldestId);
        }
      }
      bucket = {
        tokens: this.requests_per_minute,
        lastRefillMs: input.nowMs,
      };
      this.buckets.set(id, bucket);
    }

    // 3. Refill tokens
    const elapsedMs = input.nowMs - bucket.lastRefillMs;
    if (elapsedMs > 0) {
      const refillRatePerMs = this.requests_per_minute / (60 * 1000);
      const refilled = elapsedMs * refillRatePerMs;
      bucket.tokens = Math.min(this.requests_per_minute, bucket.tokens + refilled);
      bucket.lastRefillMs = input.nowMs;
    }

    // 4. Determine allowed status
    let allowed = false;
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      allowed = true;
    }

    // Calculate headers
    const headers: Record<string, string> = {
      "X-RateLimit-Limit": this.requests_per_minute.toString(),
      "X-RateLimit-Remaining": Math.floor(bucket.tokens).toString(),
    };

    const refillRatePerSec = this.requests_per_minute / 60;
    const missingTokens = this.requests_per_minute - bucket.tokens;
    const resetTimeSeconds = Math.ceil(input.nowMs / 1000 + (missingTokens / refillRatePerSec));
    headers["X-RateLimit-Reset"] = resetTimeSeconds.toString();

    if (allowed) {
      return { allowed, headers };
    } else {
      const neededTokens = 1 - bucket.tokens;
      const retryAfterSeconds = Math.ceil(neededTokens / refillRatePerSec);
      headers["Retry-After"] = retryAfterSeconds.toString();
      return {
        allowed,
        retryAfterSeconds,
        headers,
      };
    }
  }
}
