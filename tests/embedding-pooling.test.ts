import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { loadConfig } from "../src/config";
import { resolveEmbeddingPooling, resolveEmbeddingPrefixes } from "../src/embedding-format";
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

describe("ONNX conversion presets", () => {
  test.each([
    ["onnx-community/Qwen3-Embedding-0.6B-ONNX", "Qwen/Qwen3-Embedding-0.6B"],
    ["onnx-community/Qwen3-Embedding-4B-ONNX", "Qwen/Qwen3-Embedding-4B"],
    ["onnx-community/Qwen3-Embedding-8B-ONNX", "Qwen/Qwen3-Embedding-8B"],
    ["onnx-community/harrier-oss-v1-270m-ONNX", "microsoft/harrier-oss-v1-270m"],
    ["onnx-community/harrier-oss-v1-0.6b-ONNX", "microsoft/harrier-oss-v1-0.6b"],
    ["Xenova/bge-small-en-v1.5", "BAAI/bge-small-en-v1.5"],
    ["Xenova/bge-base-en-v1.5", "BAAI/bge-base-en-v1.5"],
    ["Xenova/bge-large-en-v1.5", "BAAI/bge-large-en-v1.5"],
    ["Xenova/e5-small-v2", "intfloat/e5-small-v2"],
    ["Xenova/e5-base-v2", "intfloat/e5-base-v2"],
    ["Xenova/e5-large-v2", "intfloat/e5-large-v2"],
    ["Xenova/multilingual-e5-small", "intfloat/multilingual-e5-small"],
    ["Xenova/multilingual-e5-base", "intfloat/multilingual-e5-base"],
    ["Xenova/multilingual-e5-large", "intfloat/multilingual-e5-large"],
  ])("should format and pool %s like %s", (conversion, original) => {
    expect(resolveEmbeddingPrefixes({ model: conversion })).toEqual(resolveEmbeddingPrefixes({ model: original }));
    expect(resolveEmbeddingPooling({ model: conversion })).toBe(resolveEmbeddingPooling({ model: original }));
  });

  test.each(["Xenova/gte-small", "my-org/bge-small-en-v1.5-finetuned", "Xenova/e5-small-v2-finetuned"])(
    "should leave %s on plain input and mean pooling",
    (model) => {
      expect(resolveEmbeddingPrefixes({ model })).toEqual({ query_prefix: "", document_prefix: "" });
      expect(resolveEmbeddingPooling({ model })).toBe("mean");
    },
  );
});
