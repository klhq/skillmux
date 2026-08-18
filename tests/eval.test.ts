import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeRankingMetrics, evalVault, loadEvalCases, type EvalCase } from "../src/eval";
import { backfillEmbeddings, configure, rebuildIndex } from "../src/router-core";
import type { Config } from "../src/types";

const tmp = mkdtempSync(join(tmpdir(), "skillmux-eval-"));
const vault = join(tmp, "vault");
const config: Config = {
  vault_path: vault,
  local_vault_paths: [],
  state_dir: join(tmp, "state"),
  recall: { k_lexical: 5, k_vector: 5, k_rerank: 5 },
  output: { top_k: 5, max_top_k: 50 },
  inference: {
    mode: "local",
    bundle: "gte-small-v1",
    models_dir: join(tmp, "models"),
    embedding: { model: "Xenova/gte-small", dimension: 3, device: "cpu", dtype: "q8" },
  },
};

const vector = (text: string) => text.includes("stopped") || text.includes("runtime")
  ? Float32Array.from([1, 0, 0])
  : Float32Array.from([0, 1, 0]);

beforeAll(async () => {
  for (const [id, description] of [
    ["docker-manager", "Inspect failed runtime services and container logs."],
    ["image-processing", "Resize and convert image files."],
  ] as const) {
    const dir = join(vault, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), `---\nname: ${id}\ndescription: ${description}\n---\nbody`);
  }
  configure({ config, clients: { embed: async (texts) => texts.map(vector) } });
  await rebuildIndex();
  await backfillEmbeddings();
});

afterAll(() => {
  configure({});
  rmSync(tmp, { recursive: true, force: true });
});

describe("ranking evaluation dataset parsing", () => {
  test("accepts valid dataset with query, split, and relevant_skill_ids", () => {
    const path = join(tmp, "valid-queries.json");
    writeFileSync(
      path,
      JSON.stringify([
        { query: "run docker logs", split: "tune", relevant_skill_ids: ["docker-manager"] },
        { query: "unjudged query", split: "test", relevant_skill_ids: [] },
      ]),
    );
    const cases = loadEvalCases(path);
    expect(cases).toEqual([
      { query: "run docker logs", split: "tune", relevant_skill_ids: ["docker-manager"] },
      { query: "unjudged query", split: "test", relevant_skill_ids: [] },
    ]);
  });

  test("rejects legacy 'expected' field with actionable migration error", () => {
    const path = join(tmp, "legacy-expected.json");
    writeFileSync(path, JSON.stringify([{ query: "run docker logs", expected: ["docker-manager"] }]));
    expect(() => loadEvalCases(path)).toThrow(/expected.*relevant_skill_ids/i);
  });

  test("rejects legacy 'expected_outcome' field with actionable migration error", () => {
    const path = join(tmp, "legacy-outcome.json");
    writeFileSync(
      path,
      JSON.stringify([
        { query: "run docker logs", expected_outcome: "matched", relevant_skill_ids: ["docker-manager"] },
      ]),
    );
    expect(() => loadEvalCases(path)).toThrow(/expected_outcome/i);
  });

  test("rejects malformed evaluation fixtures", () => {
    const path = join(tmp, "invalid-queries.json");
    writeFileSync(path, JSON.stringify([{ query: "", relevant_skill_ids: [] }]));
    expect(() => loadEvalCases(path)).toThrow();
  });
});

describe("ranking metrics computation", () => {
  test("computes recall@5, recall@10, MRR, and nDCG@10 accurately for single-relevant cases", () => {
    const cases: EvalCase[] = [
      { query: "q1", relevant_skill_ids: ["skill-a"] },
      { query: "q2", relevant_skill_ids: ["skill-b"] },
    ];
    // q1: skill-a at rank 1 (recall@5=1, recall@10=1, MRR=1, nDCG@10=1)
    // q2: skill-b at rank 2 (recall@5=1, recall@10=1, MRR=0.5, nDCG@10=1/log2(3) / 1)
    const rankings = [
      ["skill-a", "x", "y"],
      ["x", "skill-b", "y"],
    ];
    const metrics = computeRankingMetrics(rankings, cases);
    expect(metrics.recall_at_5).toBe(1);
    expect(metrics.recall_at_10).toBe(1);
    expect(metrics.mrr).toBe((1 + 0.5) / 2);
    const expectedNdcgQ2 = (1 / Math.log2(3)) / (1 / Math.log2(2));
    expect(metrics.ndcg_at_10).toBeCloseTo((1 + expectedNdcgQ2) / 2, 5);
  });

  test("computes multi-relevant cases with partial recall and proper IDCG normalization", () => {
    const cases: EvalCase[] = [
      { query: "multi", relevant_skill_ids: ["skill-a", "skill-b"] },
    ];
    // skill-a at rank 1, skill-b at rank 3
    const rankings = [["skill-a", "x", "skill-b", "y"]];
    const metrics = computeRankingMetrics(rankings, cases);
    expect(metrics.recall_at_5).toBe(1.0);
    expect(metrics.recall_at_10).toBe(1.0);
    expect(metrics.mrr).toBe(1.0); // first relevant is rank 1 -> 1/1
    const dcg = 1 / Math.log2(2) + 1 / Math.log2(4); // 1 + 0.5 = 1.5
    const idcg = 1 / Math.log2(2) + 1 / Math.log2(3); // 1 + 1/log2(3)
    expect(metrics.ndcg_at_10).toBeCloseTo(dcg / idcg, 5);
  });

  test("excludes unjudged queries from metric denominator and reports zero for all-unjudged", () => {
    const mixedCases: EvalCase[] = [
      { query: "judged", relevant_skill_ids: ["skill-a"] },
      { query: "unjudged", relevant_skill_ids: [] },
    ];
    const rankings = [
      ["skill-a"],
      ["other"],
    ];
    const metrics = computeRankingMetrics(rankings, mixedCases);
    expect(metrics.recall_at_5).toBe(1);
    expect(metrics.recall_at_10).toBe(1);
    expect(metrics.mrr).toBe(1);
    expect(metrics.ndcg_at_10).toBe(1);

    const allUnjudged: EvalCase[] = [
      { query: "unjudged1", relevant_skill_ids: [] },
      { query: "unjudged2", relevant_skill_ids: [] },
    ];
    const unjudgedMetrics = computeRankingMetrics([["a"], ["b"]], allUnjudged);
    expect(unjudgedMetrics).toEqual({
      recall_at_5: 0,
      recall_at_10: 0,
      mrr: 0,
      ndcg_at_10: 0,
    });
  });
});

describe("local labeled evaluation", () => {
  test("reports lexical and hybrid recall@5, recall@10, MRR, nDCG@10, and queries breakdown without a reranker", async () => {
    const report = await evalVault([
      { query: "why did my container stop", relevant_skill_ids: ["docker-manager"] },
      { query: "unlabelled query", relevant_skill_ids: [] },
    ]);
    expect(report.queries).toBe(2);
    expect(report.judged_queries).toBe(1);
    expect(report.unjudged_queries).toBe(1);
    expect(report.hybrid.recall_at_5).toBe(1);
    expect(report.hybrid.recall_at_10).toBe(1);
    expect(report.hybrid.mrr).toBe(1);
    expect(report.hybrid.ndcg_at_10).toBe(1);
    expect(report.lexical.recall_at_5).toBe(1);
    expect(report.lexical.recall_at_10).toBe(1);
    expect(report.lexical.mrr).toBe(1);
    expect(report.lexical.ndcg_at_10).toBe(1);
  });

  test("records case details including candidates, relevant_skill_ids, latency, recall settings, and degradation state without outcome", async () => {
    const remoteConfig: Config = {
      ...config,
      recall: { k_lexical: 5, k_vector: 5, k_rerank: 2 },
      inference: {
        mode: "remote",
        timeout_ms: 2000,
        embedding: {
          provider: "openai",
          endpoint: "http://127.0.0.1:9/v1/embeddings",
          model: "test-embedding",
          dimension: 3,
        },
        reranker: {
          adapter: "jina-v1",
          endpoint: "http://127.0.0.1:9/rerank",
          model: "test-reranker",
        },
      },
    };
    configure({
      config: remoteConfig,
      clients: {
        embed: async (texts) => texts.map(vector),
        rerank: async (_query, docs) => docs.map((doc) => doc.skill_id === "docker-manager" ? 0.99 : 0.1),
      },
    });

    const report = await evalVault([{ query: "why did my container stop", relevant_skill_ids: ["docker-manager"] }]);
    expect(report.cases).toBeDefined();
    expect(report.cases!.length).toBe(1);
    const c = report.cases![0]!;
    expect(c.query).toBe("why did my container stop");
    expect(c.relevant_skill_ids).toEqual(["docker-manager"]);
    expect((c as any).expected).toBeUndefined();
    expect((c as any).outcome).toBeUndefined();
    expect(c.recall_settings.k_lexical).toBe(5);
    expect(c.recall_settings.k_vector).toBe(5);
    expect(c.recall_settings.k_rerank).toBe(2);
    expect(c.candidates.length).toBeGreaterThan(0);
    expect(c.candidates[0]!.fused_rank).toBe(1);
    expect(c.candidates[0]!.reranked_rank).toBe(1);
    expect(c.retrieval).toBe("reranked");

    configure({ config, clients: { embed: async (texts) => texts.map(vector) } });
  });

  test("uses delivered fused order when reranker degrades", async () => {
    const remoteConfig: Config = {
      ...config,
      recall: { k_lexical: 5, k_vector: 5, k_rerank: 2 },
      inference: {
        mode: "remote",
        timeout_ms: 2000,
        embedding: {
          provider: "openai",
          endpoint: "http://127.0.0.1:9/v1/embeddings",
          model: "test-embedding",
          dimension: 3,
        },
        reranker: {
          adapter: "jina-v1",
          endpoint: "http://127.0.0.1:9/rerank",
          model: "test-reranker",
        },
      },
    };
    configure({
      config: remoteConfig,
      clients: {
        embed: async (texts) => texts.map(vector),
        rerank: async () => {
          throw new Error("Reranker unreachable");
        },
      },
    });

    const report = await evalVault([{ query: "why did my container stop", relevant_skill_ids: ["docker-manager"] }]);
    expect(report.cases).toBeDefined();
    expect(report.cases![0]!.retrieval).toBe("hybrid");
    expect(report.cases![0]!.degraded_from).toBe("reranked");
    expect(report.hybrid.recall_at_5).toBe(1);
    expect(report.hybrid.mrr).toBe(1);

    configure({ config, clients: { embed: async (texts) => texts.map(vector) } });
  });
});
