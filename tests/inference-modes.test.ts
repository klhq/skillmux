import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { embeddingFingerprint, loadConfig, rerankerFingerprint } from "../src/config";
import { ingestVault, openIndex, skillsNeedingVectors, upsertVector, vectorTopK } from "../src/db";
import type { Config } from "../src/types";

describe("embedding fingerprint", () => {
  test("tracks effective document format while preserving query-only and legacy vector compatibility", async () => {
    const config = await loadConfig("/does/not/exist/config.toml");
    const original = embeddingFingerprint(config);
    expect(original).toBe(`local:${config.inference.mode === "local" ? config.inference.bundle : ""}:${config.inference.embedding.model}:${config.inference.embedding.dimension}`);

    config.inference.embedding.query_prefix = "Custom query: ";
    expect(embeddingFingerprint(config)).toBe(original);
    config.inference.embedding.document_prefix = "Document: ";
    expect(embeddingFingerprint(config)).not.toBe(original);
    const customDocument = embeddingFingerprint(config);
    config.inference.embedding.query_prefix = "Another query: ";
    expect(embeddingFingerprint(config)).toBe(customDocument);
    config.inference.embedding.document_prefix = "";
    expect(embeddingFingerprint(config)).toBe(original);

    config.inference.embedding.model = "intfloat/e5-base-v2";
    delete config.inference.embedding.document_prefix;
    const preset = embeddingFingerprint(config);
    config.inference.embedding.document_prefix = "passage: ";
    expect(embeddingFingerprint(config)).toBe(preset);
    config.inference.embedding.document_prefix = "";
    expect(embeddingFingerprint(config)).not.toBe(preset);
  });

  test("tracks effective local pooling while preserving mean-pooled vectors", async () => {
    const config = await loadConfig("/does/not/exist/config.toml");
    if (config.inference.mode !== "local") throw new Error("expected local defaults");
    const original = embeddingFingerprint(config);

    config.inference.embedding.pooling = "mean";
    expect(embeddingFingerprint(config)).toBe(original);
    config.inference.embedding.pooling = "last_token";
    expect(embeddingFingerprint(config)).not.toBe(original);

    config.inference.embedding.model = "BAAI/bge-small-en-v1.5";
    delete config.inference.embedding.pooling;
    const preset = embeddingFingerprint(config);
    config.inference.embedding.pooling = "cls";
    expect(embeddingFingerprint(config)).toBe(preset);
    config.inference.embedding.pooling = "mean";
    expect(embeddingFingerprint(config)).not.toBe(preset);
  });

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

describe("vector retrieval freshness", () => {
  test("returns only current, compatible vectors before applying the result limit", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "skillmux-vector-freshness-"));
    const db = openIndex(stateDir);
    const fingerprint = "remote:openai:current-model:3";
    const contentHash = "current-content";
    const fixtures = [
      { id: "stale-content", hash: "old-content", fingerprint, vector: [1, 0, 0] },
      { id: "old-model", hash: contentHash, fingerprint: "remote:openai:old-model:3", vector: [1, 0, 0] },
      { id: "legacy-vector", hash: contentHash, fingerprint: "", vector: [1, 0, 0] },
      { id: "wrong-dimension", hash: contentHash, fingerprint, vector: [1, 0] },
      { id: "current-best", hash: contentHash, fingerprint, vector: [1, 1, 0] },
      { id: "current-second", hash: contentHash, fingerprint, vector: [0, 1, 0] },
    ];

    try {
      ingestVault(db, fixtures.map(({ id }) => ({
        skill_id: id,
        title: id,
        description: "",
        aliases: [],
        content_sha256: contentHash,
        body: "",
      })));
      for (const fixture of fixtures) {
        upsertVector(db, fixture.id, fixture.hash, fixture.fingerprint, Float32Array.from(fixture.vector));
      }

      const query = Float32Array.from([1, 0, 0]);
      for (const limit of [2, 10]) {
        expect(vectorTopK(db, query, limit, fingerprint).map((row) => row.skill_id))
          .toEqual(["current-best", "current-second"]);
      }
    } finally {
      db.close();
      rmSync(stateDir, { recursive: true, force: true });
    }
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
