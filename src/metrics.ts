import type { ReadinessSnapshot } from "./readiness";
import type { DeploymentIdentity } from "./deployment";
import type { FetchCorrelation } from "./types";

type MetricsDeploymentIdentity = Pick<
  DeploymentIdentity,
  "version" | "runtime" | "image_variant"
>;

/** Ranks above this share one label value, which keeps label cardinality fixed. */
const MAX_RANK_LABEL = 10;
const RESOLVE_RESULTS = ["candidates", "empty"] as const;

function rankLabel(rank: number | null): string {
  if (rank === null) return "none";
  return rank > MAX_RANK_LABEL ? `${MAX_RANK_LABEL + 1}+` : String(rank);
}

export class MetricsRegistry {
  private resolveResults = new Map<string, number>();
  private fetchRanks = new Map<string, number>();
  private uncorrelatedFetches = 0;

  private requests = new Map<string, number>();

  private buckets = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0];
  private latencyBuckets = new Array(this.buckets.length).fill(0);
  private latencyInf = 0;
  private latencySum = 0;
  private latencyCount = 0;

  private errors = 0;
  private rateLimitsExceeded = 0;
  private degradations = new Map<string, number>();
  private readiness: ReadinessSnapshot | null = null;
  private deployment: MetricsDeploymentIdentity | null = null;

  setReadiness(readiness: ReadinessSnapshot) {
    this.readiness = readiness;
  }

  setDeployment(deployment: MetricsDeploymentIdentity) {
    this.deployment = deployment;
  }

  recordRequest(method: string) {
    this.requests.set(method, (this.requests.get(method) || 0) + 1);
  }

  recordDegradation(stage: "embedding" | "reranker", reason: string) {
    const key = `${stage}:${reason}`;
    this.degradations.set(key, (this.degradations.get(key) || 0) + 1);
  }

  recordResolveLatencySeconds(seconds: number) {
    this.latencySum += seconds;
    this.latencyCount++;
    for (let i = 0; i < this.buckets.length; i++) {
      if (seconds <= this.buckets[i]!) {
        this.latencyBuckets[i]++;
      }
    }
    this.latencyInf++;
  }

  /** Counts one resolve_skill call by whether it returned any candidates. */
  recordResolveResult(candidateCount: number) {
    const key = candidateCount > 0 ? "candidates" : "empty";
    this.resolveResults.set(key, (this.resolveResults.get(key) || 0) + 1);
  }

  /**
   * Counts one main-file fetch_skill call. A correlated fetch is bucketed by the
   * rank the skill had in its resolve shortlist, or "none" when the fetched
   * skill was not in that shortlist.
   */
  recordFetch(correlation: FetchCorrelation) {
    if (!correlation.correlated) {
      this.uncorrelatedFetches++;
      return;
    }
    const key = rankLabel(correlation.rank);
    this.fetchRanks.set(key, (this.fetchRanks.get(key) || 0) + 1);
  }

  recordError() {
    this.errors++;
  }

  recordRateLimitExceeded() {
    this.rateLimitsExceeded++;
  }

  render(): string {
    const lines: string[] = [];

    // Requests total
    lines.push("# HELP skill_router_requests_total Total count of incoming MCP requests.");
    lines.push("# TYPE skill_router_requests_total counter");
    for (const [method, count] of this.requests) {
      lines.push(`skill_router_requests_total{method="${method}"} ${count}`);
    }

    // Latency histogram
    lines.push("# HELP skill_router_resolve_latency_seconds Latency histogram of resolve_skill executions.");
    lines.push("# TYPE skill_router_resolve_latency_seconds histogram");
    for (let i = 0; i < this.buckets.length; i++) {
      let le = this.buckets[i]!.toString();
      // Format to remove trailing .0 if integer to match test
      if (Number.isInteger(this.buckets[i]!)) {
        le = this.buckets[i]!.toFixed(0);
      }
      lines.push(`skill_router_resolve_latency_seconds_bucket{le="${le}"} ${this.latencyBuckets[i]}`);
    }
    lines.push(`skill_router_resolve_latency_seconds_bucket{le="+Inf"} ${this.latencyInf}`);
    lines.push(`skill_router_resolve_latency_seconds_sum ${this.latencySum}`);
    lines.push(`skill_router_resolve_latency_seconds_count ${this.latencyCount}`);

    // Routing quality: no query text or skill IDs are ever used as labels.
    lines.push("# HELP skill_router_resolve_results_total resolve_skill calls by whether the shortlist had candidates.");
    lines.push("# TYPE skill_router_resolve_results_total counter");
    for (const result of RESOLVE_RESULTS) {
      lines.push(`skill_router_resolve_results_total{result="${result}"} ${this.resolveResults.get(result) || 0}`);
    }

    lines.push("# HELP skill_router_fetch_ranked_total fetch_skill calls linked to a resolve_skill call, by the fetched skill's shortlist rank (none: not in the shortlist).");
    lines.push("# TYPE skill_router_fetch_ranked_total counter");
    const rankLabels = [
      ...Array.from({ length: MAX_RANK_LABEL }, (_, i) => String(i + 1)),
      `${MAX_RANK_LABEL + 1}+`,
      "none",
    ];
    for (const rank of rankLabels) {
      lines.push(`skill_router_fetch_ranked_total{rank="${rank}"} ${this.fetchRanks.get(rank) || 0}`);
    }

    lines.push("# HELP skill_router_fetch_uncorrelated_total fetch_skill calls with no matching resolve_skill request_id.");
    lines.push("# TYPE skill_router_fetch_uncorrelated_total counter");
    lines.push(`skill_router_fetch_uncorrelated_total ${this.uncorrelatedFetches}`);

    // Errors total
    lines.push("# HELP skill_router_errors_total Total count of server and query routing errors.");
    lines.push("# TYPE skill_router_errors_total counter");
    lines.push(`skill_router_errors_total ${this.errors}`);

    // Rate limits exceeded
    lines.push("# HELP skill_router_rate_limits_exceeded_total Total count of HTTP requests rejected by rate limiting.");
    lines.push("# TYPE skill_router_rate_limits_exceeded_total counter");
    lines.push(`skill_router_rate_limits_exceeded_total ${this.rateLimitsExceeded}`);

    // Degraded retrieval total
    lines.push("# HELP skill_router_degraded_retrieval_total Total count of degraded retrieval fallbacks labelled by stage and reason.");
    lines.push("# TYPE skill_router_degraded_retrieval_total counter");
    for (const [key, count] of this.degradations) {
      const [stage, reason] = key.split(":");
      lines.push(`skill_router_degraded_retrieval_total{stage="${stage}",reason="${reason}"} ${count}`);
    }

    lines.push("# HELP skill_router_ready Whether the service is ready to route requests.");
    lines.push("# TYPE skill_router_ready gauge");
    lines.push(`skill_router_ready ${this.readiness?.status === "ready" ? 1 : 0}`);
    lines.push("# HELP skill_router_retrieval_capability Active retrieval capability.");
    lines.push("# TYPE skill_router_retrieval_capability gauge");
    for (const capability of ["exact", "reranked", "hybrid", "lexical"]) {
      lines.push(`skill_router_retrieval_capability{capability="${capability}"} ${this.readiness?.retrieval === capability ? 1 : 0}`);
    }

    if (this.deployment) {
      const imageVariant = this.deployment.image_variant ?? "none";
      lines.push("# HELP skill_router_deployment_info Immutable deployment identity for operator comparison.");
      lines.push("# TYPE skill_router_deployment_info gauge");
      lines.push(`skill_router_deployment_info{version="${this.deployment.version}",runtime="${this.deployment.runtime}",image_variant="${imageVariant}"} 1`);
    }

    return lines.join("\n") + "\n";
  }
}
