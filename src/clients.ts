import type { Clients, Config, RemoteRerankerConfig } from "./types";
import { expandHome } from "./config";
import type { pipeline as createPipeline } from "@huggingface/transformers";

interface EmbeddingResponse {
  data: { index: number; embedding: number[] }[];
}

type RemoteErrorKind = "configuration" | "availability" | "protocol";

export class RemoteInferenceError extends Error {
  constructor(
    public readonly kind: RemoteErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "RemoteInferenceError";
  }
}

// Lazy-loaded model instances for in-process ONNX inference
type FeatureExtractor = Awaited<ReturnType<typeof createPipeline<"feature-extraction">>>;

let localEmbedder: FeatureExtractor | null = null;

function authorizationHeaders(
  apiKeyEnv: string | undefined,
  configKey: string,
): Record<string, string> {
  if (apiKeyEnv === undefined) return {};
  const apiKey = process.env[apiKeyEnv];
  if (apiKey === undefined || apiKey === "") {
    throw new RemoteInferenceError(
      "configuration",
      `${configKey} names environment variable "${apiKeyEnv}", but it is unset or empty.`,
    );
  }
  return { authorization: `Bearer ${apiKey}` };
}

function rerankerRequestBody(
  reranker: RemoteRerankerConfig,
  query: string,
  docs: { skill_id: string; text: string }[],
): Record<string, unknown> {
  if (reranker.adapter === "jina-v1") {
    return {
      model: reranker.model,
      query,
      documents: docs.map((doc) => doc.text),
    };
  }
  return {
    model: reranker.model,
    query,
    documents: docs.map((doc) => ({
      text: doc.text,
      id: doc.skill_id,
      meta: {},
    })),
    top_n: docs.length,
    return_documents: false,
  };
}

function parseRerankerScores(
  adapter: RemoteRerankerConfig["adapter"],
  value: unknown,
  documentCount: number,
): number[] {
  const response = value as { results?: unknown };
  if (
    typeof response !== "object" ||
    response === null ||
    !Array.isArray(response.results) ||
    response.results.length !== documentCount
  ) {
    throw new RemoteInferenceError(
      "protocol",
      `reranker adapter "${adapter}" returned an incomplete results array`,
    );
  }

  const scores = new Array<number>(documentCount);
  const seen = new Set<number>();
  for (const value of response.results) {
    const result = value as { index?: unknown; relevance_score?: unknown };
    if (
      typeof result !== "object" ||
      result === null ||
      !Number.isInteger(result.index) ||
      (result.index as number) < 0 ||
      (result.index as number) >= documentCount ||
      seen.has(result.index as number) ||
      typeof result.relevance_score !== "number" ||
      !Number.isFinite(result.relevance_score)
    ) {
      throw new RemoteInferenceError(
        "protocol",
        `reranker adapter "${adapter}" returned invalid indexed scores`,
      );
    }
    seen.add(result.index as number);
    scores[result.index as number] = result.relevance_score;
  }
  return scores;
}

async function fetchRerankerScores(
  reranker: RemoteRerankerConfig,
  timeoutMs: number,
  headers: Record<string, string>,
  query: string,
  docs: { skill_id: string; text: string }[],
): Promise<number[]> {
  if (docs.length === 0) return [];

  let response: Response;
  try {
    response = await fetch(reranker.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(rerankerRequestBody(reranker, query, docs)),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error instanceof RemoteInferenceError) throw error;
    throw new RemoteInferenceError(
      "availability",
      `reranker adapter "${reranker.adapter}" request failed`,
    );
  }
  if (!response.ok) {
    throw new RemoteInferenceError(
      "availability",
      `reranker adapter "${reranker.adapter}" returned HTTP ${response.status}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    throw new RemoteInferenceError(
      "protocol",
      `reranker adapter "${reranker.adapter}" returned malformed JSON`,
    );
  }
  return parseRerankerScores(reranker.adapter, parsed, docs.length);
}

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
  const remoteAuth =
    config.inference.mode === "remote"
      ? {
          embedding: authorizationHeaders(
            config.inference.embedding.api_key_env,
            "inference.embedding.api_key_env",
          ),
          reranker: config.inference.reranker
            ? authorizationHeaders(
                config.inference.reranker.api_key_env,
                "inference.reranker.api_key_env",
              )
            : {},
        }
      : undefined;
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
      const cleanBase = embedding.base_url.replace(/\/$/, "");
      const embedPath = cleanBase.endsWith("/v1") ? "/embeddings" : "/v1/embeddings";
      const response = await fetch(`${cleanBase}${embedPath}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...remoteAuth?.embedding,
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
      return fetchRerankerScores(
        reranker,
        inference.timeout_ms,
        remoteAuth?.reranker ?? {},
        query,
        docs,
      );
    };
  }
  return clients;
}
