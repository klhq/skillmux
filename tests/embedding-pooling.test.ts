import { describe, expect, test } from "bun:test";
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
