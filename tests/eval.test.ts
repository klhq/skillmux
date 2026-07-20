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
  state_dir: join(tmp, "state"),
  recall: { k_lexical: 5, k_vector: 5 },
  thresholds: { match_score: 0.9, match_margin: 0.2, candidate_floor: 0.4, candidate_limit: 5 },
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
});
