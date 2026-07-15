# Spec: Skill Router — Custom Models & Observability (custom-models-observability)

<!-- status: approved 2026-07-15 -->

## Goal
Add configurable overrides for local model names and vector dimensions, make the model downloader script dynamic, and implement observability (Prometheus `/metrics` and `/health` endpoints) for the HTTP server transport.

## Acceptance Criteria

- [ ] **AC1 — Model Configuration & Env Overrides**: The configuration loader supports environment overrides for model names and vector dimensions:
  - `EMBED_MODEL` / `SKILL_ROUTER_EMBED_MODEL` overrides `embedding.model`
  - `EMBED_DIMENSION` / `SKILL_ROUTER_EMBED_DIMENSION` (parsed as integer) overrides `embedding.dimension`
  - `RERANK_MODEL` / `SKILL_ROUTER_RERANK_MODEL` overrides `rerank.model`
- [ ] **AC2 — Dynamic Model Downloader**: The `scripts/download-models.ts` script uses `loadConfig()` to resolve the configured model names, devices, and dtypes (including environment overrides) and dynamically downloads them instead of hardcoding target names.
- [ ] **AC3 — Health Endpoint**: The HTTP server exposes a `/health` endpoint. A `GET /health` request returns status code `200` with JSON `{"status":"ok"}`.
- [ ] **AC4 — Prometheus Metrics Endpoint**: The HTTP server exposes a `/metrics` endpoint. A `GET /metrics` request returns status code `200` with content-type `text/plain; version=0.0.4` and Prometheus formatted text containing the following metrics:
  - `skill_router_requests_total{method="<mcp_method>"}`: Total count of incoming MCP requests.
  - `skill_router_resolve_outcomes_total{outcome="matched|ambiguous|no_match"}`: Total count of `resolve_skill` query outcomes.
  - `skill_router_resolve_latency_seconds_bucket`: Latency histogram of `resolve_skill` executions (with buckets `0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0`).
  - `skill_router_resolve_latency_seconds_sum` and `skill_router_resolve_latency_seconds_count`.
  - `skill_router_errors_total`: Total count of server and query routing errors.
- [ ] **AC5 — Lightweight Metrics Implementation**: Metrics tracking is implemented directly in memory using plain TypeScript/JavaScript structures to avoid adding heavy external telemetry packages, maintaining Bun's low-latency and light footprint profile.

## Scope

- Config overrides in `src/config.ts` for model names and dimensions.
- Refactoring `scripts/download-models.ts` to dynamically fetch configured weights.
- In-memory metrics recorder and formatter class/helpers.
- Server route interception in `src/server.ts` to handle HTTP `GET /health` and `GET /metrics` requests.
- Integration tests asserting health response schema and metrics format/updates.

## Out of Scope

- Scraping daemon configuration (Prometheus installation manifests).
- Client-side metrics reporting (OpenTelemetry SDK integrations).
- Metrics persistence (saving metrics history to SQLite).
- Custom endpoint path configuration (e.g. configuring `/metrics` to be `/stats`).

## Tasks

1. **Task 1: Custom Model Configuration & Dynamic Downloader**
   - Update `src/config.ts` to process environment variables `EMBED_MODEL`, `EMBED_DIMENSION`, and `RERANK_MODEL`.
   - Update `scripts/download-models.ts` to load configuration and dynamically pull configured models.
   - Assert configuration variable loading in `tests/config-env.test.ts`.

2. **Task 2: Observability Endpoint Routing & Metrics Collection**
   - Design and implement a simple `MetricsRegistry` in a new file `src/metrics.ts`.
   - Intercept GET requests in `src/server.ts` for `/health` and `/metrics`.
   - Instrument MCP request handling and resolve outcome routing to record request counts, outcomes, and latencies.
   - Implement comprehensive integration tests verifying metrics format, counters incrementing on requests, and health status checks.
