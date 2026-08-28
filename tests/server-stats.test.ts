import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { insertAudit } from "../src/db";
import { configure, getRuntime } from "../src/router-core";
import { startServer } from "../src/server";
import type { Config } from "../src/types";

const dirs: string[] = [];

afterEach(() => {
  configure({});
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeConfig(root: string, overrides: Partial<Config> = {}): Config {
  const vault = join(root, "vault");
  const skill = join(vault, "example-skill");
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), "---\nname: Example\ndescription: Example routing skill.\n---\nbody");
  return {
    vault_path: vault,
    local_vault_paths: [],
    state_dir: join(root, "state"),
    recall: { k_lexical: 20, k_vector: 20, k_rerank: 10 },
    output: { top_k: 10, max_top_k: 50 },
    inference: {
      mode: "local",
      bundle: "gte-small-v1",
      models_dir: join(root, "models"),
      embedding: { model: "Xenova/gte-small", dimension: 3 },
    },
    ...overrides,
  };
}

describe("GET /stats", () => {
  test("returns an aggregated StatsResponse for the requested window", async () => {
    const root = mkdtempSync(join(tmpdir(), "skillmux-server-stats-"));
    dirs.push(root);
    const config = makeConfig(root);
    const clients = { embed: async (texts: string[]) => texts.map(() => Float32Array.from([1, 0, 0])) };
    const handle = await startServer({ transport: "http", port: 0, config, clients });

    const { auditDb: db } = await getRuntime();
    insertAudit(db, {
      ts: new Date().toISOString(),
      query: "in window",
      retrieval: "reranked",
      candidates: [{ skill_id: "example-skill", score: 0.9 }],
      latency_ms: 12,
    });

    const res = await fetch(`http://127.0.0.1:${handle.port}/stats?since=30d`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.total_requests).toBe(1);
    expect(body.empty_shortlist_count).toBe(0);
    expect(body.empty_shortlist_rate).toBe(0);
    expect(body.retrieval_totals).toEqual({ exact: 0, reranked: 1, hybrid: 0, lexical: 0 });
    expect(body.degraded_count).toBe(0);
    expect(body.average_latency_ms).toBe(12);
    expect(body.skills).toEqual([{ skill_id: "example-skill", candidate_count: 1 }]);
    expect(body.top_empty_shortlist_queries).toEqual([]);

    await handle.stop();
  });

  test("rejects a malformed since window with 400", async () => {
    const root = mkdtempSync(join(tmpdir(), "skillmux-server-stats-"));
    dirs.push(root);
    const config = makeConfig(root);
    const clients = { embed: async (texts: string[]) => texts.map(() => Float32Array.from([1, 0, 0])) };
    const handle = await startServer({ transport: "http", port: 0, config, clients });

    const res = await fetch(`http://127.0.0.1:${handle.port}/stats?since=not-a-window`);

    expect(res.status).toBe(400);

    await handle.stop();
  });

  test("requires auth when server.auth_enabled is true, unlike /health and /metrics", async () => {
    const root = mkdtempSync(join(tmpdir(), "skillmux-server-stats-"));
    dirs.push(root);
    process.env.STATS_TEST_TOKEN = "secret-token";
    const config = makeConfig(root, {
      server: { auth_enabled: true, auth_token_env: "STATS_TEST_TOKEN", allowed_origins: ["*"] },
    });
    const clients = { embed: async (texts: string[]) => texts.map(() => Float32Array.from([1, 0, 0])) };
    const handle = await startServer({ transport: "http", port: 0, config, clients });

    const unauthed = await fetch(`http://127.0.0.1:${handle.port}/stats?since=30d`);
    expect(unauthed.status).toBe(401);

    const authed = await fetch(`http://127.0.0.1:${handle.port}/stats?since=30d`, {
      headers: { authorization: "Bearer secret-token" },
    });
    expect(authed.status).toBe(200);

    const health = await fetch(`http://127.0.0.1:${handle.port}/health`);
    expect(health.status).toBe(200);

    await handle.stop();
    delete process.env.STATS_TEST_TOKEN;
  });
});
