import { describe, expect, test } from "bun:test";
import { MetricsRegistry } from "../src/metrics";

describe("MetricsRegistry", () => {
  test("renders Prometheus text for all required metric families", () => {
    const metrics = new MetricsRegistry();

    const body = metrics.render();

    expect(body).toContain("# HELP skill_router_requests_total Total count of incoming MCP requests.");
    expect(body).toContain("# TYPE skill_router_requests_total counter");
    expect(body).toContain("# HELP skill_router_resolve_outcomes_total Total count of resolve_skill query outcomes.");
    expect(body).toContain("# TYPE skill_router_resolve_outcomes_total counter");
    expect(body).toContain("# HELP skill_router_resolve_latency_seconds Latency histogram of resolve_skill executions.");
    expect(body).toContain("# TYPE skill_router_resolve_latency_seconds histogram");
    expect(body).toContain("# HELP skill_router_errors_total Total count of server and query routing errors.");
    expect(body).toContain("# TYPE skill_router_errors_total counter");
  });

  test("renders readiness and retrieval capability gauges", () => {
    const registry = new MetricsRegistry();
    registry.setReadiness({
      status: "ready",
      retrieval: "hybrid",
      skills: 10,
      index_current: true,
      embedding: "ready",
      reranker: "not_configured",
    });

    const output = registry.render();
    expect(output).toContain("skill_router_ready 1");
    expect(output).toContain('skill_router_retrieval_capability{capability="hybrid"} 1');
    expect(output).toContain('skill_router_retrieval_capability{capability="lexical"} 0');
  });

  test("renders deployment identity without configuration or credential values", () => {
    const registry = new MetricsRegistry();

    registry.setDeployment({
      version: "1.2.0",
      runtime: "docker",
      image_variant: "slim",
    });

    const output = registry.render();

    expect(output).toContain("# HELP skill_router_deployment_info Immutable deployment identity for operator comparison.");
    expect(output).toContain("# TYPE skill_router_deployment_info gauge");
    expect(output).toContain('skill_router_deployment_info{version="1.2.0",runtime="docker",image_variant="slim"} 1');
    expect(output).not.toContain("api_key");
    expect(output).not.toContain("token");
  });

  test("increments request counter by MCP method label", () => {
    const metrics = new MetricsRegistry();

    metrics.recordRequest("resolve_skill");
    metrics.recordRequest("resolve_skill");
    metrics.recordRequest("fetch_skill");

    const body = metrics.render();

    expect(body).toContain('skill_router_requests_total{method="resolve_skill"} 2');
    expect(body).toContain('skill_router_requests_total{method="fetch_skill"} 1');
  });

  test("increments resolve outcome counters by outcome label", () => {
    const metrics = new MetricsRegistry();

    metrics.recordResolveOutcome("matched");
    metrics.recordResolveOutcome("ambiguous");
    metrics.recordResolveOutcome("no_match");
    metrics.recordResolveOutcome("matched");

    const body = metrics.render();

    expect(body).toContain('skill_router_resolve_outcomes_total{outcome="matched"} 2');
    expect(body).toContain('skill_router_resolve_outcomes_total{outcome="ambiguous"} 1');
    expect(body).toContain('skill_router_resolve_outcomes_total{outcome="no_match"} 1');
  });

  test("records resolve latency into the documented histogram buckets plus sum and count", () => {
    const metrics = new MetricsRegistry();

    metrics.recordResolveLatencySeconds(0.004);
    metrics.recordResolveLatencySeconds(0.02);
    metrics.recordResolveLatencySeconds(0.3);
    metrics.recordResolveLatencySeconds(12);

    const body = metrics.render();

    for (const bucket of [
      "0.005",
      "0.01",
      "0.025",
      "0.05",
      "0.1",
      "0.25",
      "0.5",
      "1",
      "2.5",
      "5",
      "10",
      "+Inf",
    ]) {
      expect(body).toContain(`skill_router_resolve_latency_seconds_bucket{le="${bucket}"}`);
    }
    expect(body).toContain("skill_router_resolve_latency_seconds_sum 12.324");
    expect(body).toContain("skill_router_resolve_latency_seconds_count 4");
    expect(body).toContain('skill_router_resolve_latency_seconds_bucket{le="0.005"} 1');
    expect(body).toContain('skill_router_resolve_latency_seconds_bucket{le="0.025"} 2');
    expect(body).toContain('skill_router_resolve_latency_seconds_bucket{le="0.5"} 3');
    expect(body).toContain('skill_router_resolve_latency_seconds_bucket{le="+Inf"} 4');
  });

  test("increments the error counter", () => {
    const metrics = new MetricsRegistry();

    metrics.recordError();
    metrics.recordError();

    const body = metrics.render();

    expect(body).toContain("skill_router_errors_total 2");
  });

  test("renders the rate limit exceeded counter family and increments it", () => {
    const metrics = new MetricsRegistry();

    metrics.recordRateLimitExceeded();
    metrics.recordRateLimitExceeded();

    const body = metrics.render();

    expect(body).toContain("# HELP skill_router_rate_limits_exceeded_total Total count of HTTP requests rejected by rate limiting.");
    expect(body).toContain("# TYPE skill_router_rate_limits_exceeded_total counter");
    expect(body).toContain("skill_router_rate_limits_exceeded_total 2");
  });

  test("increments degraded retrieval counter labelled by stage and reason", () => {
    const metrics = new MetricsRegistry();

    metrics.recordDegradation("reranker", "reranker_timeout");
    metrics.recordDegradation("reranker", "reranker_timeout");
    metrics.recordDegradation("embedding", "embedding_unavailable");

    const body = metrics.render();

    expect(body).toContain("# HELP skill_router_degraded_retrieval_total Total count of degraded retrieval fallbacks labelled by stage and reason.");
    expect(body).toContain("# TYPE skill_router_degraded_retrieval_total counter");
    expect(body).toContain('skill_router_degraded_retrieval_total{stage="reranker",reason="reranker_timeout"} 2');
    expect(body).toContain('skill_router_degraded_retrieval_total{stage="embedding",reason="embedding_unavailable"} 1');
  });
});

