import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { embeddingFingerprint, loadConfig, rerankerFingerprint } from "../src/config";
import { ingestVault, openIndex, skillsNeedingVectors, upsertVector } from "../src/db";
import type { Config } from "../src/types";

describe("embedding fingerprint", () => {
  test("changes with model identity even when dimensions match", async () => {
    const local = await loadConfig("/does/not/exist/config.toml");
    const remote: Config = {
      ...local,
      inference: {
        mode: "remote",
        timeout_ms: 2000,
        embedding: {
          provider: "openai",
          endpoint: "https://embed.example.com/v1/embeddings",
          model: "another-1024-model",
          dimension: 1024,
        },
        reranker: {
          adapter: "jina-v1",
          endpoint: "https://rerank.example.com/rerank",
          model: "reranker",
        },
      },
    };

    expect(embeddingFingerprint(local)).not.toBe(embeddingFingerprint(remote));
  });

  test("marks a same-dimension vector stale after fingerprint changes", async () => {
    const stateDir = `/tmp/skillmux-fingerprint-${crypto.randomUUID()}`;
    const db = openIndex(stateDir);
    ingestVault(db, [
      {
        skill_id: "example-skill",
        title: "Example Skill",
        description: "Example description",
        aliases: [],
        content_sha256: "a".repeat(64),
        body: "body",
      },
    ]);
    upsertVector(db, "example-skill", "a".repeat(64), "local:bundle:model:3", Float32Array.from([1, 0, 0]));

    expect(skillsNeedingVectors(db, 3, "local:bundle:model:3")).toHaveLength(0);
    expect(skillsNeedingVectors(db, 3, "remote:openai:model:3")).toHaveLength(1);
    db.close();
  });
});

describe("reranker fingerprint", () => {
  test("tracks adapter and model but excludes endpoint", async () => {
    const config = await loadConfig("/does/not/exist/config.toml");
    const remote: Config = {
      ...config,
      inference: {
        mode: "remote",
        timeout_ms: 2000,
        embedding: {
          provider: "openai",
          endpoint: "https://embed.example.com/v1/embeddings",
          model: "embed",
          dimension: 384,
        },
        reranker: {
          adapter: "jina-v1",
          endpoint: "https://one.example.com/v1/rerank",
          model: "reranker",
        },
      },
    };
    const fingerprint = rerankerFingerprint(remote);
    expect(fingerprint).toBe("remote:jina-v1:reranker");

    const moved = structuredClone(remote);
    if (moved.inference.mode !== "remote" || !moved.inference.reranker) {
      throw new Error("expected reranker");
    }
    moved.inference.reranker.endpoint = "https://two.example.com/rerank";
    expect(rerankerFingerprint(moved)).toBe(fingerprint);
    moved.inference.reranker.adapter = "bifrost-v1";
    expect(rerankerFingerprint(moved)).not.toBe(fingerprint);
    moved.inference.reranker.adapter = "jina-v1";
    moved.inference.reranker.model = "new-reranker";
    expect(rerankerFingerprint(moved)).not.toBe(fingerprint);
  });
});
