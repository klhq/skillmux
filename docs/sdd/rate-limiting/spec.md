# Spec: Skill Router — API Rate Limiting (rate-limiting)

<!-- status: approved 2026-07-15 -->

## Goal
Implement a robust, in-memory token-bucket rate limiter for the HTTP server transport to prevent abuse of model inference resources, configurable via `config.toml` and environment variables.

## Acceptance Criteria

- [ ] **AC1 — Configuration & Env Overrides**: Support rate limit configuration under the server config block:
  - Config parameters inside `config.toml`:
    ```toml
    [server.rate_limit]
    enabled = true
    requests_per_minute = 60
    ```
  - Default `requests_per_minute` is `60` if `enabled` is true but the limit is not specified.
  - Environment variable overrides (namespaced variants take precedence):
    - `HTTP_RATE_LIMIT_ENABLED` / `SKILL_ROUTER_HTTP_RATE_LIMIT_ENABLED` (parsed as boolean)
    - `HTTP_RATE_LIMIT_RPM` / `SKILL_ROUTER_HTTP_RATE_LIMIT_RPM` (parsed as integer)
- [ ] **AC2 — Token-Bucket Rate Limiter**: Implement a per-client token-bucket rate limiter:
  - The rate limiting identifier is determined as:
    - The Bearer token if server authentication is enabled (`auth_enabled = true`).
    - The client's IP address if authentication is disabled (retrieved via `server.requestIP(req)?.address` with fallback to `X-Forwarded-For` header or `"127.0.0.1"`).
  - Tokens refill continuously at a rate of `requests_per_minute / 60` tokens per second, up to the maximum capacity of `requests_per_minute`.
- [ ] **AC3 — HTTP 429 Too Many Requests**:
  - Exceeding the rate limit returns an HTTP `429 Too Many Requests` response.
  - The 429 response includes the `Retry-After` header indicating the number of seconds (rounded up to nearest integer) the client must wait before another request is allowed.
  - Every rate-limited response includes the following standard headers:
    - `X-RateLimit-Limit`: The configured requests per minute.
    - `X-RateLimit-Remaining`: The number of tokens remaining in the client's bucket.
    - `X-RateLimit-Reset`: The Unix epoch timestamp (seconds) when the bucket will be completely refilled.
- [ ] **AC4 — Metrics Integration**:
  - Add rate-limited requests to our metrics tracking:
    - Requests rejected with a 429 count as `skill_router_requests_total{method="<mcp_method>"}`.
    - Expose `skill_router_rate_limits_exceeded_total` counter to track total number of rate-limited requests.

## Scope

- Types updates in `src/types.ts` to include `RateLimitConfig` under `ServerConfig`.
- Configuration parsing and overrides logic in `src/config.ts`.
- Rate limiter class `RateLimiter` inside a new file `src/rate-limiter.ts`.
- Server middleware check in `src/server.ts` intercepting incoming HTTP requests and appending rate limit headers.
- Prometheus metrics counter update in `src/metrics.ts` for tracking rate limit rejections.
- Integration tests in `tests/rate-limiting.test.ts` verifying rate limits, HTTP status codes, headers, and token refilling behavior.

## Out of Scope

- Distributed rate limiting (e.g. using Redis). In-memory state per server instance is sufficient.
- Dynamic rate limit configurations per API key (all tokens/IPs share the same configured RPM).

## Tasks

1. **Task 1: Types & Configuration Overrides**
   - Update `ServerConfig` and defaults in `src/types.ts` and `src/config.ts` to support the new `rate_limit` sub-config.
   - Implement environment overrides for `HTTP_RATE_LIMIT_ENABLED` and `HTTP_RATE_LIMIT_RPM`.
   - Update tests in `tests/config-env.test.ts` to assert correct loading and validation of rate limiting configurations.

2. **Task 2: Rate Limiter Class implementation**
   - Create `src/rate-limiter.ts` containing the `RateLimiter` class implementing the token-bucket algorithm.
   - Support IP address lookup from `Bun.serve`'s `fetch(req, server)` context.
   - Write unit tests in `tests/rate-limiter.test.ts` to verify token consumption, refilling, headers generation, and identifier resolution.

3. **Task 3: Server Integration & Metrics Update**
   - Update `MetricsRegistry` in `src/metrics.ts` to support the new `skill_router_rate_limits_exceeded_total` metric.
   - Integrate the rate limiter middleware into `src/server.ts` inside `Bun.serve`'s fetch loop.
   - Run integration tests to verify 429 rejections, header correctness, and metric increments.
