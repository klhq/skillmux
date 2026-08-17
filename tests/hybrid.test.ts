import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  backfillEmbeddings,
  configure,
  resolveSkill,
  retrieveAndRerank,
  retrieveAndRerankSnapshot,
} from "../src/router-core";
import type { Config } from "../src/types";

// Hybrid recall (AC6): FTS5 top-k ∪ cosine top-k. The query shares zero
// vocabulary with semantic-skill's description; only the embedding lane can
// surface it. Vectors are deterministic: query and semantic-skill map close
// together, everything else far away.
const tmp = mkdtempSync(join(tmpdir(), "skillmux-hybrid-"));
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
  local_vault_paths: [],
  state_dir: join(tmp, "state"),
  recall: { k_lexical: 15, k_vector: 15 },
  thresholds: { match_score: 0.9, match_margin: 0.2, candidate_floor: 0.4, candidate_limit: 5 },
  output: { ambiguous_candidate_limit: 5 },
  inference: {
    mode: "remote",
    timeout_ms: 2000,
    embedding: {
      provider: "openai",
      endpoint: "http://127.0.0.1:9/v1/embeddings",
      model: "microsoft/harrier-oss-v1-0.6b",
      dimension: 3,
    },
    reranker: { adapter: "jina-v1", endpoint: "http://127.0.0.1:9", model: "BAAI/bge-reranker-v2-m3" },
      thresholds: { match_score: 0.9, match_margin: 0.2, candidate_floor: 0.4 },
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
  test("raw retrieval returns the full reranked shortlist with one reranker call", async () => {
    let rerankerCalls = 0;
    if (config.inference.mode !== "remote") throw new Error("expected remote config");
    const { thresholds: _thresholds, ...uncalibratedInference } = config.inference;
    configure({
      config: {
        ...config,
        inference: uncalibratedInference,
      },
      clients: {
        embed: async (texts) => texts.map(vectorFor),
        rerank: async (_query, docs) => {
          rerankerCalls++;
          return docs.map((_, index) => 0.99 - index * 0.1);
        },
      },
    });

    const raw = await retrieveAndRerank({ query: "quantum flux routing" });
    expect(raw.retrieval).toBe("reranked");
    expect(raw.candidates.length).toBeGreaterThan(1);
    expect(raw.candidates.every((candidate) => candidate.score !== null)).toBe(true);
    expect(rerankerCalls).toBe(1);

    const resolved = await resolveSkill({ query: "quantum flux routing" });
    expect(resolved.outcome).toBe("ambiguous");
    expect(resolved.retrieval).toBe("reranked");
    expect(rerankerCalls).toBe(2);

    configure({
      config,
      clients: {
        embed: async (texts) => texts.map(vectorFor),
        rerank: async (_query, docs) => docs.map(() => 0.5),
      },
    });
  });

  test("sends no more than k_rerank candidates to the reranker", async () => {
    let receivedDocCount = 0;
    configure({
      config: {
        ...config,
        recall: { k_lexical: 15, k_vector: 15, k_rerank: 2 },
      },
      clients: {
        embed: async (texts) => texts.map(vectorFor),
        rerank: async (_query, docs) => {
          receivedDocCount = docs.length;
          return docs.map(() => 0.8);
        },
      },
    });

    const raw = await retrieveAndRerank({ query: "quantum flux routing" });
    expect(receivedDocCount).toBe(2);
    expect(raw.candidates.length).toBe(2);

    configure({
      config,
      clients: {
        embed: async (texts) => texts.map(vectorFor),
        rerank: async (_query, docs) => docs.map(() => 0.5),
      },
    });
  });

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

    const result = await resolveSkill({ query: "容器 部署", forceLexical: true });

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

    expect(result.retrieval).toBe("lexical");
    expect(result.outcome).not.toBe("matched");
    if (result.outcome !== "ambiguous") throw new Error(`expected ambiguous, got ${result.outcome}`);
    expect(result.degraded_from).toBe("reranked");
    expect(result.degradation_reason).toBe("embedding_unavailable");
    const ids = result.candidates.map((c) => c.skill_id);
    expect(ids).toContain("lexical-skill");
    expect(ids).not.toContain("semantic-skill");
    for (const candidate of result.candidates) expect(candidate).not.toHaveProperty("score");
  });

  test("returns degradation_reason embedding_timeout when embedding times out", async () => {
    const timeoutErr = new Error("request timed out");
    timeoutErr.name = "TimeoutError";
    configure({
      config,
      clients: {
        embed: async () => {
          throw timeoutErr;
        },
        rerank: async (_query, docs) => docs.map(() => 0.99),
      },
    });

    const result = await resolveSkill({ query: "quantum flux routing" });
    expect(result.retrieval).toBe("lexical");
    expect(result.degraded_from).toBe("reranked");
    expect(result.degradation_reason).toBe("embedding_timeout");
  });

  test("does not write the raw query to degradation logs", async () => {
    const secretQuery = "deploy with token secret-123";
    const logLines: string[] = [];
    const originalConsoleError = console.error;
    configure({
      config,
      clients: {
        embed: async () => {
          throw new Error("embedding endpoint unreachable");
        },
        rerank: async (_query, docs) => docs.map(() => 0.99),
      },
    });
    console.error = (...args: unknown[]) => logLines.push(args.map(String).join(" "));

    try {
      await resolveSkill({ query: secretQuery });
    } finally {
      console.error = originalConsoleError;
    }

    expect(logLines.join("\n")).not.toContain(secretQuery);
  });

  test("returns degradation_reason reranker_timeout and falls back to hybrid when reranker times out", async () => {
    const timeoutErr = new Error("reranker request timed out");
    timeoutErr.name = "TimeoutError";
    configure({
      config,
      clients: {
        embed: async (texts) => texts.map(vectorFor),
        rerank: async () => {
          throw timeoutErr;
        },
      },
    });

    const result = await resolveSkill({ query: "quantum flux routing" });
    expect(result.retrieval).toBe("hybrid");
    expect(result.degraded_from).toBe("reranked");
    expect(result.degradation_reason).toBe("reranker_timeout");
    if (result.outcome !== "ambiguous") throw new Error("expected ambiguous");
    expect(result.candidates.length).toBeGreaterThan(0);
  });

  test("returns degradation_reason reranker_unavailable when reranker fails with 503", async () => {
    configure({
      config,
      clients: {
        embed: async (texts) => texts.map(vectorFor),
        rerank: async () => {
          throw new Error("reranker 503 Service Unavailable");
        },
      },
    });

    const result = await resolveSkill({ query: "quantum flux routing" });
    expect(result.retrieval).toBe("hybrid");
    expect(result.degraded_from).toBe("reranked");
    expect(result.degradation_reason).toBe("reranker_unavailable");
  });

  test("starts embedding request concurrently before local lexical search completes and waits for candidate fusion before reranking", async () => {
    const events: string[] = [];

    // Controllable deferred promise for embed
    let resolveEmbed!: (val: Float32Array[]) => void;
    const embedPromise = new Promise<Float32Array[]>((resolve) => {
      resolveEmbed = resolve;
    });

    configure({
      config,
      clients: {
        embed: async (texts) => {
          events.push("embed:start");
          const res = await embedPromise;
          events.push("embed:finish");
          return res;
        },
        rerank: async (_query, docs) => {
          events.push("rerank:start");
          expect(events).toContain("embed:finish");
          return docs.map(() => 0.95);
        },
      },
    });

    const retrievalPromise = retrieveAndRerank({ query: "quantum flux routing" });

    // Yield to let the event loop run: embed:start should have been triggered before lexical/vector completion
    await new Promise((r) => setTimeout(r, 10));
    expect(events).toEqual(["embed:start"]);

    // Now resolve embedding
    resolveEmbed([vectorFor("quantum flux routing")]);
    const res = await retrievalPromise;

    expect(events).toEqual(["embed:start", "embed:finish", "rerank:start"]);
    expect(res.retrieval).toBe("reranked");
    expect(res.candidates.length).toBeGreaterThan(0);
  });

  test("ordinary retrieveAndRerank() synchronizes vault changes by default while snapshot retrieval does not", async () => {
    configure({
      config,
      clients: {
        embed: async (texts) => texts.map(vectorFor),
        rerank: async (_query, docs) => docs.map(() => 0.95),
      },
    });

    writeSkill("late-added-hybrid-skill", "Dynamic handler for late-added capability.");

    // retrieveAndRerank without prior manual sync should automatically discover and index the new skill
    const res = await retrieveAndRerank({ query: "late-added-hybrid-skill" });
    expect(res.candidates.some((c) => c.skill_id === "late-added-hybrid-skill")).toBe(true);

    // Write another skill
    writeSkill("unsynced-snapshot-skill", "Dynamic handler not visible to snapshot.");
    // retrieveAndRerankSnapshot should query the existing index snapshot without triggering syncVaultIfNeeded()
    const snapshotRes = await retrieveAndRerankSnapshot({ query: "unsynced-snapshot-skill" });
    expect(snapshotRes.candidates.some((c) => c.skill_id === "unsynced-snapshot-skill")).toBe(false);
  });
});
