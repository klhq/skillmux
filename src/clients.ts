import type { Clients, Config } from "./types";
import { expandHome } from "./config";
import type { pipeline as createPipeline } from "@huggingface/transformers";

interface EmbeddingResponse {
  data: { index: number; embedding: number[] }[];
}

interface RerankResponse {
  results: { index: number; relevance_score: number }[];
}

// Lazy-loaded model instances for in-process ONNX inference
type FeatureExtractor = Awaited<ReturnType<typeof createPipeline<"feature-extraction">>>;

let localEmbedder: FeatureExtractor | null = null;

function localInference(config: Config) {
  if (config.inference.mode !== "local") throw new Error("Local inference is not configured.");
  return config.inference;
}

async function setupTransformers(cacheDir: string) {
  process.env.HF_HUB_CACHE = cacheDir;
  process.env.HF_HOME = cacheDir;

  const { env, pipeline } = await import("@huggingface/transformers");
  env.cacheDir = cacheDir;
  return pipeline;
}

async function getLocalEmbedder(config: Config): Promise<FeatureExtractor> {
  if (localEmbedder) return localEmbedder;

  const inference = localInference(config);
  const cacheDir = expandHome(inference.models_dir);
  const pipeline = await setupTransformers(cacheDir);

  localEmbedder = await pipeline("feature-extraction", inference.embedding.model, {
    device: inference.embedding.device || "cpu",
    dtype: inference.embedding.dtype || "q8",
  });
  return localEmbedder;
}

/**
 * Real HTTP clients or in-process local ONNX inference clients.
 * Every remote HTTP call is bounded by inference.timeout_ms; timeouts and transport
 * errors reject so resolveSkill can fall back to the strongest available retrieval lane.
 * Local ONNX calls run in-process using @huggingface/transformers.
 */
export function createClients(config: Config): Clients {
  const clients: Clients = {
    async embed(texts: string[]): Promise<Float32Array[]> {
      if (config.inference.mode === "local") {
        const pipe = await getLocalEmbedder(config);
        const output = await pipe(texts, { pooling: "mean", normalize: true });
        const dim = output.dims[1];
        if (dim === undefined || output.dims.length !== 2 || output.dims[0] !== texts.length) {
          throw new Error(`Embedding model returned unexpected dimensions: ${output.dims.join("x")}`);
        }
        const result: Float32Array[] = [];
        for (let i = 0; i < texts.length; i++) {
          const row = output.slice(i, null).tolist();
          if (!Array.isArray(row) || row.some((value) => typeof value !== "number")) {
            throw new Error("Embedding model returned non-numeric values.");
          }
          result.push(Float32Array.from(row));
        }
        return result;
      }

      const embedding = config.inference.embedding;
      const apiKey = embedding.api_key_env ? process.env[embedding.api_key_env] : undefined;
      const response = await fetch(`${embedding.base_url.replace(/\/$/, "")}/v1/embeddings`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({ model: embedding.model, input: texts }),
        signal: AbortSignal.timeout(config.inference.timeout_ms),
      });
      if (!response.ok) throw new Error(`embeddings endpoint returned ${response.status}`);
      const parsed = (await response.json()) as EmbeddingResponse;
      const byIndex = [...parsed.data].sort((a, b) => a.index - b.index);
      return byIndex.map((d) => Float32Array.from(d.embedding));
    },
  };
  if (config.inference.mode === "remote" && config.inference.reranker) {
    const inference = config.inference;
    clients.rerank = async (query, docs) => {
      const reranker = inference.reranker;
      if (!reranker) throw new Error("Reranker is not configured.");
      const apiKey = reranker.api_key_env ? process.env[reranker.api_key_env] : undefined;
      const response = await fetch(`${reranker.base_url.replace(/\/$/, "")}/rerank`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify({
          model: reranker.model,
          query,
          documents: docs.map((d) => d.text),
        }),
        signal: AbortSignal.timeout(inference.timeout_ms),
      });
      if (!response.ok) throw new Error(`rerank endpoint returned ${response.status}`);
      const parsed = (await response.json()) as RerankResponse;
      const scores = new Array<number>(docs.length).fill(0);
      for (const result of parsed.results) scores[result.index] = result.relevance_score;
      return scores;
    };
  }
  return clients;
}
