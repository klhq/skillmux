import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { loadConfig } from "../src/config";
import { resolveEmbeddingPooling } from "../src/embedding-format";
import type { EmbeddingPooling } from "../src/types";

describe("embedding pooling", () => {
  test.each([
    ["Xenova/gte-small", "mean"],
    ["intfloat/e5-base-v2", "mean"],
    ["intfloat/multilingual-e5-small", "mean"],
    ["BAAI/bge-small-en-v1.5", "cls"],
    ["Qwen/Qwen3-Embedding-0.6B", "last_token"],
    ["onnx-community/Qwen/Qwen3-Embedding-0.6B", "last_token"],
    ["microsoft/harrier-oss-v1-270m", "last_token"],
  ] as [string, EmbeddingPooling][])("selects the documented pooling for %s", (model, pooling) => {
    expect(resolveEmbeddingPooling({ model })).toBe(pooling);
  });

  test("should let an explicit pooling override the model preset", () => {
    expect(resolveEmbeddingPooling({ model: "Qwen/Qwen3-Embedding-0.6B", pooling: "mean" })).toBe("mean");
    expect(resolveEmbeddingPooling({ model: "my-org/custom-decoder", pooling: "last_token" })).toBe("last_token");
  });
});

describe("pooling configuration", () => {
  async function loadToml(content: string) {
    const path = `/tmp/skillmux-pooling-${crypto.randomUUID()}.toml`;
    await Bun.write(path, content);
    try {
      return await loadConfig(path);
    } finally {
      rmSync(path, { force: true });
    }
  }

  test("should accept a supported pooling for local inference", async () => {
    const config = await loadToml(`[inference.embedding]\npooling = "last_token"\n`);
    expect(config.inference.mode === "local" && config.inference.embedding.pooling).toBe("last_token");
  });

  test("should reject an unsupported pooling value", async () => {
    await expect(loadToml(`[inference.embedding]\npooling = "max"\n`)).rejects.toThrow();
  });

  test("should reject pooling for remote inference, where the server pools", async () => {
    const remote = [
      `[inference]`,
      `mode = "remote"`,
      `timeout_ms = 2000`,
      `[inference.embedding]`,
      `provider = "openai"`,
      `endpoint = "https://embed.example.com/v1/embeddings"`,
      `model = "Qwen/Qwen3-Embedding-0.6B"`,
      `dimension = 1024`,
      `pooling = "last_token"`,
    ].join("\n");
    await expect(loadToml(remote)).rejects.toThrow("pooling");
  });
});
