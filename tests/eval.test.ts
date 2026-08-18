import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evalVault, loadEvalCases } from "../src/eval";
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

describe("local labeled evaluation", () => {
  test("rejects malformed evaluation fixtures", () => {
    const path = join(tmp, "invalid-queries.json");
    writeFileSync(path, JSON.stringify([{ query: "", expected: [] }]));
    expect(() => loadEvalCases(path)).toThrow();
  });

  test("reports lexical and hybrid recall plus MRR without a reranker", async () => {
    const report = await evalVault([{ query: "why did my container stop", expected: ["docker-manager"] }]);
    expect(report.queries).toBe(1);
    expect(report.hybrid.recall_at_5).toBe(1);
    expect(report.hybrid.mrr).toBe(1);
  });

  test("records case details including fused rank, outcome, latency, recall settings, and degradation state", async () => {
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

    const report = await evalVault([{ query: "why did my container stop", expected: ["docker-manager"] }]);
    expect(report.cases).toBeDefined();
    expect(report.cases!.length).toBe(1);
    const c = report.cases![0]!;
    expect(c.query).toBe("why did my container stop");
    expect(c.recall_settings.k_lexical).toBe(5);
    expect(c.recall_settings.k_vector).toBe(5);
    expect(c.recall_settings.k_rerank).toBe(2);
    expect(c.candidates.length).toBeGreaterThan(0);
    expect(c.candidates[0]!.fused_rank).toBe(1);
    expect(c.candidates[0]!.reranked_rank).toBe(1);
    expect(c.outcome).toBe("ambiguous");
    expect(c.retrieval).toBe("reranked");

    configure({ config, clients: { embed: async (texts) => texts.map(vector) } });
  });
});
