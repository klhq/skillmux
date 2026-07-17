import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { embeddingFingerprint, loadConfig } from "../src/config";
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
          base_url: "https://embed.example.com",
          model: "another-1024-model",
          dimension: 1024,
        },
        reranker: {
          provider: "infinity",
          base_url: "https://rerank.example.com",
          model: "reranker",
        },
      },
    };

    expect(embeddingFingerprint(local)).not.toBe(embeddingFingerprint(remote));
  });

  test("marks a same-dimension vector stale after fingerprint changes", async () => {
    const stateDir = `/tmp/skill-router-fingerprint-${crypto.randomUUID()}`;
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
