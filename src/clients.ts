import type { Clients, Config, RemoteRerankerConfig } from "./types";
import { expandHome } from "./config";
import { assertHostAllowed } from "./install";
import type { pipeline as createPipeline } from "@huggingface/transformers";

export type RemoteErrorKind = "configuration" | "availability" | "protocol";

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

function assertInferenceHostAllowed(url: string, allowedHosts: string[] | undefined): void {
  try {
    assertHostAllowed(url, allowedHosts);
  } catch (error) {
    throw new RemoteInferenceError(
      "configuration",
      error instanceof Error ? error.message : String(error),
    );
  }
}

function httpFailure(surface: string, status: number): RemoteInferenceError {
  const kind: RemoteErrorKind =
    status === 401 || status === 403
      ? "configuration"
      : status === 408 || status === 429 || status >= 500
        ? "availability"
        : "protocol";
  return new RemoteInferenceError(kind, `${surface} returned HTTP ${status}`);
}

function finiteFloat32(
  values: unknown[],
  error: () => Error,
): Float32Array {
  const result = new Float32Array(values.length);
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    if (typeof value !== "number" || !Number.isFinite(value)) throw error();
    result[index] = value;
    if (!Number.isFinite(result[index]!)) throw error();
  }
  return result;
}

function parseEmbeddingVectors(
  value: unknown,
  inputCount: number,
  dimension: number,
): Float32Array[] {
  const response = value as { data?: unknown };
  if (
    typeof response !== "object" ||
    response === null ||
    !Array.isArray(response.data) ||
    response.data.length !== inputCount
  ) {
    throw new RemoteInferenceError(
      "protocol",
      "embedding endpoint returned an incomplete data array",
    );
  }

  const vectors = new Array<Float32Array>(inputCount);
  const seen = new Set<number>();
  for (const value of response.data) {
    const entry = value as { index?: unknown; embedding?: unknown };
    if (
      typeof entry !== "object" ||
      entry === null ||
      !Number.isInteger(entry.index) ||
      (entry.index as number) < 0 ||
      (entry.index as number) >= inputCount ||
      seen.has(entry.index as number) ||
      !Array.isArray(entry.embedding) ||
      entry.embedding.length !== dimension
    ) {
      throw new RemoteInferenceError(
        "protocol",
        "embedding endpoint returned invalid indexed vectors",
      );
    }
    seen.add(entry.index as number);
    vectors[entry.index as number] = finiteFloat32(
      entry.embedding,
      () => new RemoteInferenceError("protocol", "embedding endpoint returned invalid vector values"),
    );
  }
  return vectors;
}

export function parseLocalEmbeddingVectors(
  value: unknown,
  inputCount: number,
  dimension: number,
): Float32Array[] {
  if (!Array.isArray(value) || value.length !== inputCount) {
    throw new Error("Embedding model returned an unexpected batch size.");
  }
  return value.map((row) => {
    if (!Array.isArray(row) || row.length !== dimension) {
      throw new Error("Embedding model returned unexpected vector dimensions.");
    }
    return finiteFloat32(
      row,
      () => new Error("Embedding model returned invalid vector values."),
    );
  });
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
  query: string,
  docs: { skill_id: string; text: string }[],
  allowedHosts: string[] | undefined,
): Promise<number[]> {
  if (docs.length === 0) return [];

  assertInferenceHostAllowed(reranker.endpoint, allowedHosts);

  let response: Response;
  try {
    response = await fetch(reranker.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...authorizationHeaders(reranker.api_key_env, "inference.reranker.api_key_env"),
      },
      body: JSON.stringify(rerankerRequestBody(reranker, query, docs)),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error instanceof RemoteInferenceError) throw error;
    const isTimeout =
      (error as { name?: string })?.name === "TimeoutError" ||
      (error as { name?: string })?.name === "AbortError" ||
      String(error).toLowerCase().includes("timeout") ||
      String(error).toLowerCase().includes("aborted");
    if (isTimeout) {
      throw new RemoteInferenceError(
        "availability",
        `reranker adapter "${reranker.adapter}" request timed out`,
      );
    }
    throw new RemoteInferenceError(
      "availability",
      `reranker adapter "${reranker.adapter}" request failed`,
    );
  }
  if (!response.ok) {
    throw httpFailure(`reranker adapter "${reranker.adapter}"`, response.status);
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
  const clients: Clients = {
    async embed(texts: string[]): Promise<Float32Array[]> {
      if (config.inference.mode === "local") {
        const pipe = await getLocalEmbedder(config);
        const output = await pipe(texts, { pooling: "mean", normalize: true });
        const dim = output.dims[1];
        if (
          dim === undefined ||
          output.dims.length !== 2 ||
          output.dims[0] !== texts.length ||
          dim !== config.inference.embedding.dimension
        ) {
          throw new Error(`Embedding model returned unexpected dimensions: ${output.dims.join("x")}`);
        }
        const rows = Array.from({ length: texts.length }, (_, index) =>
          output.slice(index, null).tolist(),
        );
        return parseLocalEmbeddingVectors(rows, texts.length, dim);
      }

      const embedding = config.inference.embedding;
      assertInferenceHostAllowed(embedding.endpoint, config.egress?.allowed_hosts);
      let response: Response;
      try {
        response = await fetch(embedding.endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...authorizationHeaders(embedding.api_key_env, "inference.embedding.api_key_env"),
          },
          body: JSON.stringify({ model: embedding.model, input: texts }),
          signal: AbortSignal.timeout(config.inference.timeout_ms),
        });
      } catch (error) {
        if (error instanceof RemoteInferenceError) throw error;
        const isTimeout =
          (error as { name?: string })?.name === "TimeoutError" ||
          (error as { name?: string })?.name === "AbortError" ||
          String(error).toLowerCase().includes("timeout") ||
          String(error).toLowerCase().includes("aborted");
        if (isTimeout) {
          throw new RemoteInferenceError("availability", "embedding endpoint request timed out");
        }
        throw new RemoteInferenceError("availability", "embedding endpoint request failed");
      }
      if (!response.ok) throw httpFailure("embedding endpoint", response.status);

      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch {
        throw new RemoteInferenceError("protocol", "embedding endpoint returned malformed JSON");
      }
      return parseEmbeddingVectors(parsed, texts.length, embedding.dimension);
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
        query,
        docs,
        config.egress?.allowed_hosts,
      );
    };
  }
  return clients;
}
