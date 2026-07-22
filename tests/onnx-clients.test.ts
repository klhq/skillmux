import { describe, expect, test } from "bun:test";
import type { Config } from "../src/types";
import { createClients } from "../src/clients";

function localConfig(): Config {
  return {
    vault_path: "/unused",
    local_vault_paths: [],
    state_dir: "/unused",
    recall: { k_lexical: 15, k_vector: 15 },
    thresholds: { match_score: 0.9, match_margin: 0.2, candidate_floor: 0.4, candidate_limit: 5 },
    inference: {
      mode: "local",
      bundle: "gte-small-v1",
      models_dir: "./.models",
      embedding: { model: "Xenova/gte-small", dimension: 384, device: "cpu", dtype: "q8" },
    },
  };
}

describe("local ONNX clients (AC1)", () => {
  test("embed generates 384-dimensional normalized vectors using local GTE-small", async () => {
    const clients = createClients(localConfig());
    const vectors = await clients.embed(["first test text", "second test text"]);

    expect(vectors).toHaveLength(2);
    expect(vectors[0]).toBeInstanceOf(Float32Array);
    expect(vectors[0]!.length).toBe(384);
    expect(vectors[1]!.length).toBe(384);

    // Verify normalization: norm should be close to 1.0
    let norm = 0;
    for (let i = 0; i < 384; i++) {
      norm += vectors[0]![i]! * vectors[0]![i]!;
    }
    expect(Math.sqrt(norm)).toBeCloseTo(1.0, 4);
  }, 120000);

  test("does not expose a local reranker", () => {
    expect(createClients(localConfig()).rerank).toBeUndefined();
  });
});
