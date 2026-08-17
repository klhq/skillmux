import { describe, expect, test } from "bun:test";
import packageJson from "../package.json" with { type: "json" };
import { describeDeployment } from "../src/doctor";
import type { Config } from "../src/types";

function config(inference: Config["inference"]): Config {
  return {
    vault_path: "/test/vault",
    local_vault_paths: [],
    state_dir: "/test/state",
    recall: { k_lexical: 20, k_vector: 20 },
    thresholds: { candidate_limit: 5 },
    output: { ambiguous_candidate_limit: 5 },
    inference,
  };
}

describe("deployment identity", () => {
  test("describes the host CLI with its local embedding bundle", () => {
    expect(describeDeployment(config({
      mode: "local",
      bundle: "gte-small-v1",
      models_dir: "~/.cache/skillmux/models",
      embedding: { model: "Xenova/gte-small", dimension: 384 },
    }), {})).toMatchObject({
      version: packageJson.version,
      runtime: "host",
      image_variant: null,
      vault_path: "/test/vault",
      state_dir: "/test/state",
      inference_mode: "local",
      local_embedding_bundle: "gte-small-v1",
      remote_embedding_configured: false,
      remote_reranker_configured: false,
    });
  });

  test("describes a full Docker server configured for remote reranking", () => {
    expect(describeDeployment(config({
      mode: "remote",
      timeout_ms: 1_000,
      embedding: { provider: "openai", endpoint: "https://example.test/v1/embeddings", model: "embedding", dimension: 384 },
      reranker: { adapter: "jina-v1", endpoint: "https://example.test/rerank", model: "reranker" },
    }), {
      RUNNING_IN_DOCKER: "true",
      SKILLMUX_IMAGE_VARIANT: "full",
    })).toMatchObject({
      runtime: "docker",
      image_variant: "full",
      inference_mode: "remote",
      local_embedding_bundle: null,
      remote_embedding_configured: true,
      remote_reranker_configured: true,
    });
  });
});
