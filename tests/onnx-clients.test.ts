import { describe, expect, test } from "bun:test";
import type { Config } from "../src/types";
import { createClients } from "../src/clients";

function localConfig(): Config {
  return {
    vault_path: "/unused",
    state_dir: "./.models", // models are cached at workspace ./.models
    recall: { k_lexical: 15, k_vector: 15 },
    thresholds: { match_score: 0.9, match_margin: 0.2, candidate_floor: 0.4, candidate_limit: 5 },
    embedding: {
      base_url: "local://",
      api_key_env: "SKILL_ROUTER_EMBED_KEY",
      model: "Xenova/bge-m3",
      dimension: 1024,
    },
    rerank: {
      base_url: "local://",
      model: "onnx-community/bge-reranker-v2-m3-ONNX",
    },
    remote_timeout_ms: 5000,
  };
}

describe("local ONNX clients (AC1)", () => {
  test("embed generates 1024-dimensional normalized vectors using local BGE-M3", async () => {
    const clients = createClients(localConfig());
    const vectors = await clients.embed(["first test text", "second test text"]);

    expect(vectors).toHaveLength(2);
    expect(vectors[0]).toBeInstanceOf(Float32Array);
    expect(vectors[0]!.length).toBe(1024);
    expect(vectors[1]!.length).toBe(1024);

    // Verify normalization: norm should be close to 1.0
    let norm = 0;
    for (let i = 0; i < 1024; i++) {
      norm += vectors[0]![i]! * vectors[0]![i]!;
    }
    expect(Math.sqrt(norm)).toBeCloseTo(1.0, 4);
  }, 30000);

  test("rerank generates valid sigmoid scores using local BGE-Reranker-v2-m3", async () => {
    const clients = createClients(localConfig());
    const scores = await clients.rerank("weather forecast", [
      { skill_id: "match", text: "the weather forecast calls for sunny skies today" },
      { skill_id: "mismatch", text: "bananas are yellow and taste sweet" },
    ]);

    expect(scores).toHaveLength(2);
    console.log("Reranker scores:", scores);
    expect(scores[0]!).toBeGreaterThan(scores[1]!); // match is ranked higher than mismatch
    expect(scores[1]!).toBeLessThan(0.01);         // mismatch is very low

  }, 30000);
});
