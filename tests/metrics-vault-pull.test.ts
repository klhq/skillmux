import { describe, expect, test } from "bun:test";
import { MetricsRegistry } from "../src/metrics";

describe("vault pull metrics", () => {
  test("a server that never pulls exposes no pull series", () => {
    expect(new MetricsRegistry().render()).not.toContain("vault_pull");
  });

  test("an enabled puller exposes zeroed counters before the first pull", () => {
    const registry = new MetricsRegistry();
    registry.enableVaultPull();

    const text = registry.render();

    for (const result of ["cloned", "updated", "up-to-date", "failed"]) {
      expect(text).toContain(`skill_router_vault_pull_total{result="${result}"} 0`);
    }
    expect(text).not.toContain("skill_router_vault_last_pull_success_timestamp_seconds ");
  });

  test("counts each outcome and stamps the last success, which a failure does not move", () => {
    const registry = new MetricsRegistry();
    registry.enableVaultPull();

    registry.recordVaultPull("updated", new Date("2026-11-02T00:00:00Z"));
    registry.recordVaultPull("up-to-date", new Date("2026-11-02T00:10:00Z"));
    registry.recordVaultPull("failed", new Date("2026-11-02T00:20:00Z"));
    const text = registry.render();

    expect(text).toContain('skill_router_vault_pull_total{result="updated"} 1');
    expect(text).toContain('skill_router_vault_pull_total{result="up-to-date"} 1');
    expect(text).toContain('skill_router_vault_pull_total{result="failed"} 1');
    expect(text).toContain(`skill_router_vault_last_pull_success_timestamp_seconds ${Date.parse("2026-11-02T00:10:00Z") / 1000}`);
  });
});
