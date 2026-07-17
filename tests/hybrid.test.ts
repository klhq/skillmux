import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backfillEmbeddings, configure, resolveSkill } from "../src/router-core";
import type { Config } from "../src/types";

// Hybrid recall (AC6): FTS5 top-k ∪ cosine top-k. The query shares zero
// vocabulary with semantic-skill's description; only the embedding lane can
// surface it. Vectors are deterministic: query and semantic-skill map close
// together, everything else far away.
const tmp = mkdtempSync(join(tmpdir(), "skill-router-hybrid-"));
const vaultDir = join(tmp, "vault");

function writeSkill(id: string, description: string) {
  const dir = join(vaultDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${id}\ndescription: ${description}\n---\n\n# ${id}\n\nBody of ${id}.\n`,
  );
}

function vectorFor(text: string): Float32Array {
  if (text.includes("quantum")) return Float32Array.from([1, 0, 0]);
  if (text.includes("zebra")) return Float32Array.from([0.98, 0.2, 0]);
  return Float32Array.from([0, 1, 0]);
}

const config: Config = {
  vault_path: vaultDir,
  state_dir: join(tmp, "state"),
  recall: { k_lexical: 15, k_vector: 15 },
  thresholds: { match_score: 0.9, match_margin: 0.2, candidate_floor: 0.4, candidate_limit: 5 },
  inference: {
    mode: "remote",
    timeout_ms: 2000,
    embedding: {
      provider: "openai",
      base_url: "http://127.0.0.1:9",
      model: "microsoft/harrier-oss-v1-0.6b",
      dimension: 3,
    },
    reranker: { provider: "infinity", base_url: "http://127.0.0.1:9", model: "BAAI/bge-reranker-v2-m3" },
  },
};

beforeAll(async () => {
  writeSkill("lexical-skill", "Handles quantum flux routing requests directly.");
  writeSkill("semantic-skill", "Cares for zebra habitats and their upkeep.");
  writeSkill("unrelated-skill", "Formats spreadsheets and prints reports.");
  writeSkill("zh-deploy-skill", "部署 容器 到遠端主機 deploys container stacks to remote hosts.");

  configure({
    config,
    clients: {
      embed: async (texts) => texts.map(vectorFor),
      rerank: async (_query, docs) => docs.map(() => 0.5),
    },
  });
  await backfillEmbeddings();
});

afterAll(() => {
  configure({});
  rmSync(tmp, { recursive: true, force: true });
});

describe("hybrid recall (AC6)", () => {
  test("includes a semantically-near skill that lexical recall alone misses", async () => {
    const result = await resolveSkill({ query: "quantum flux routing" });

    expect(result.outcome).toBe("ambiguous");
    if (result.outcome !== "ambiguous") throw new Error("unreachable");
    const ids = result.candidates.map((c) => c.skill_id);
    expect(ids).toContain("lexical-skill");
    expect(ids).toContain("semantic-skill");
  });

  test("re-embeds stored vectors when the configured dimension changes", async () => {
    if (config.inference.mode !== "remote") throw new Error("expected remote config");
    configure({
      config: {
        ...config,
        inference: { ...config.inference, embedding: { ...config.inference.embedding, dimension: 8 } },
      },
      clients: {
        embed: async (texts) => texts.map(() => new Float32Array(8).fill(0.5)),
        rerank: async (_query, docs) => docs.map(() => 0.5),
      },
    });

    const reembedded = await backfillEmbeddings();

    expect(reembedded).toBe(4); // every skill's 3-dim vector is stale at dim 8
  });

  test("CJK query terms reach lexical recall (degraded lane included)", async () => {
    configure({ config });

    const result = await resolveSkill({ query: "容器 部署", forceDegraded: true });

    expect(result.outcome).toBe("ambiguous");
    if (result.outcome !== "ambiguous") throw new Error("unreachable");
    expect(result.candidates.map((c) => c.skill_id)).toContain("zh-deploy-skill");
  });

  test("degrades to lexical-only recall when the embed client fails (AC7)", async () => {
    configure({
      config,
      clients: {
        embed: async () => {
          throw new Error("embedding endpoint unreachable");
        },
        rerank: async (_query, docs) => docs.map(() => 0.99),
      },
    });

    const result = await resolveSkill({ query: "quantum flux routing" });

    expect(result.degraded).toBe(true);
    expect(result.outcome).not.toBe("matched");
    if (result.outcome !== "ambiguous") throw new Error(`expected ambiguous, got ${result.outcome}`);
    const ids = result.candidates.map((c) => c.skill_id);
    expect(ids).toContain("lexical-skill");
    expect(ids).not.toContain("semantic-skill");
    for (const candidate of result.candidates) expect(candidate.rerank_score).toBeNull();
  });
});
