import type { Clients, Config } from "./types";
import { expandHome } from "./config";
import path from "node:path";

interface EmbeddingResponse {
  data: { index: number; embedding: number[] }[];
}

interface RerankResponse {
  results: { index: number; relevance_score: number }[];
}

// Lazy-loaded model instances for in-process ONNX inference
let localEmbedder: any = null;
let localReranker: any = null;

async function getLocalEmbedder(config: Config) {
  if (localEmbedder) return localEmbedder;

  const cacheDir = path.resolve(
    process.env.SKILL_ROUTER_MODELS_DIR ||
    expandHome(config.embedding.base_url.startsWith("local://") ? config.state_dir : "") ||
    "./.models"
  );
  process.env.HF_HUB_CACHE = cacheDir;
  process.env.HF_HOME = cacheDir;

  const { env, pipeline } = await import("@huggingface/transformers");
  env.cacheDir = cacheDir;

  localEmbedder = await pipeline("feature-extraction", config.embedding.model || "Xenova/bge-m3", {
    device: "cpu",
    dtype: "q8",
  });
  return localEmbedder;
}

async function getLocalReranker(config: Config) {
  if (localReranker) return localReranker;

  const cacheDir = path.resolve(
    process.env.SKILL_ROUTER_MODELS_DIR ||
    expandHome(config.rerank.base_url.startsWith("local://") ? config.state_dir : "") ||
    "./.models"
  );
  process.env.HF_HUB_CACHE = cacheDir;
  process.env.HF_HOME = cacheDir;

  const { env, pipeline } = await import("@huggingface/transformers");
  env.cacheDir = cacheDir;

  localReranker = await pipeline("text-classification", config.rerank.model || "onnx-community/bge-reranker-v2-m3-ONNX", {
    device: "cpu",
    dtype: "q8",
  });
  return localReranker;
}

/**
 * Real HTTP clients or in-process local ONNX inference clients.
 * Every remote HTTP call is bounded by remote_timeout_ms; timeouts and transport
 * errors reject, which resolveSkill turns into the degraded lane (AC7).
 * Local ONNX calls run in-process using @huggingface/transformers when base_url
 * is set to 'local://'.
 */
export function createClients(config: Config): Clients {
  return {
    async embed(texts: string[]): Promise<Float32Array[]> {
      if (config.embedding.base_url === "local://") {
        const pipe = await getLocalEmbedder(config);
        const output = await pipe(texts, { pooling: "mean", normalize: true });
        const dim = output.dims[1];
        const result: Float32Array[] = [];
        for (let i = 0; i < texts.length; i++) {
          const slice = output.data.subarray(i * dim, (i + 1) * dim);
          result.push(new Float32Array(slice));
        }
        return result;
      }

      const apiKey = process.env[config.embedding.api_key_env] ?? "";
      const response = await fetch(`${config.embedding.base_url}/v1/embeddings`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ model: config.embedding.model, input: texts }),
        signal: AbortSignal.timeout(config.remote_timeout_ms),
      });
      if (!response.ok) throw new Error(`embeddings endpoint returned ${response.status}`);
      const parsed = (await response.json()) as EmbeddingResponse;
      const byIndex = [...parsed.data].sort((a, b) => a.index - b.index);
      return byIndex.map((d) => Float32Array.from(d.embedding));
    },

    async rerank(query: string, docs: { skill_id: string; text: string }[]): Promise<number[]> {
      if (config.rerank.base_url === "local://") {
        const pipe = await getLocalReranker(config);
        const scores = new Array<number>(docs.length);
        for (let i = 0; i < docs.length; i++) {
          const doc = docs[i]!;
          const inputs = await pipe.tokenizer(query, {
            text_pair: doc.text,
            padding: true,
            truncation: true,
            return_tensors: "pt",
          });
          const output = await pipe.model(inputs);
          const score = output.logits.sigmoid().data[0]!;
          scores[i] = score;
        }
        return scores;
      }

      const response = await fetch(`${config.rerank.base_url}/rerank`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: config.rerank.model,
          query,
          documents: docs.map((d) => d.text),
        }),
        signal: AbortSignal.timeout(config.remote_timeout_ms),
      });
      if (!response.ok) throw new Error(`rerank endpoint returned ${response.status}`);
      const parsed = (await response.json()) as RerankResponse;
      const scores = new Array<number>(docs.length).fill(0);
      for (const result of parsed.results) scores[result.index] = result.relevance_score;
      return scores;
    },
  };
}
