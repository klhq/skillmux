export class MetricsRegistry {
  private requests = new Map<string, number>();
  private outcomes = new Map<string, number>();
  
  private buckets = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0];
  private latencyBuckets = new Array(this.buckets.length).fill(0);
  private latencyInf = 0;
  private latencySum = 0;
  private latencyCount = 0;

  private errors = 0;

  recordRequest(method: string) {
    this.requests.set(method, (this.requests.get(method) || 0) + 1);
  }

  recordResolveOutcome(outcome: string) {
    this.outcomes.set(outcome, (this.outcomes.get(outcome) || 0) + 1);
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

  recordError() {
    this.errors++;
  }

  render(): string {
    const lines: string[] = [];

    // Requests total
    lines.push("# HELP skill_router_requests_total Total count of incoming MCP requests.");
    lines.push("# TYPE skill_router_requests_total counter");
    for (const [method, count] of this.requests) {
      lines.push(`skill_router_requests_total{method="${method}"} ${count}`);
    }

    // Resolve outcomes total
    lines.push("# HELP skill_router_resolve_outcomes_total Total count of resolve_skill query outcomes.");
    lines.push("# TYPE skill_router_resolve_outcomes_total counter");
    for (const [outcome, count] of this.outcomes) {
      lines.push(`skill_router_resolve_outcomes_total{outcome="${outcome}"} ${count}`);
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

    // Errors total
    lines.push("# HELP skill_router_errors_total Total count of server and query routing errors.");
    lines.push("# TYPE skill_router_errors_total counter");
    lines.push(`skill_router_errors_total ${this.errors}`);

    return lines.join("\n") + "\n";
  }
}
