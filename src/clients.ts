import type { Clients, Config } from "./types";

interface EmbeddingResponse {
  data: { index: number; embedding: number[] }[];
}

interface RerankResponse {
  results: { index: number; relevance_score: number }[];
}

/**
 * Real HTTP clients: OpenAI-compatible /v1/embeddings and Infinity-native
 * /rerank. Every call is bounded by remote_timeout_ms; timeouts and transport
 * errors reject, which resolveSkill turns into the degraded lane (AC7).
 */
export function createClients(config: Config): Clients {
  return {
    async embed(texts: string[]): Promise<Float32Array[]> {
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
