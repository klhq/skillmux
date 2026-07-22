import { afterAll, describe, expect, test } from "bun:test";
import type { Config } from "../src/types";

import { createClients } from "../src/clients";

// Fake remote endpoints (gateway /v1/embeddings, Infinity /rerank) at the
// network boundary — the clients under test speak real HTTP to them.
const requests: { path: string; auth: string | null; body: unknown }[] = [];

const server = Bun.serve({
  port: 0,
  fetch: async (req) => {
    const url = new URL(req.url);
    const body = await req.json();
    requests.push({ path: url.pathname, auth: req.headers.get("authorization"), body });
    if ((body as { input?: string[] }).input?.[0] === "slow request") await Bun.sleep(500);
    if (url.pathname === "/v1/embeddings") {
      const inputs = (body as { input: string[] }).input;
      return Response.json({
        data: inputs.map((_, index) => ({ index, embedding: [0.1 * (index + 1), 0.2, 0.3] })),
      });
    }
    if (url.pathname === "/v1/rerank") {
      const documents = (body as { documents: string[] }).documents;
      // Results deliberately returned in reverse order to prove the client
      // maps scores back by index, not by response position.
      return Response.json({
        results: documents
          .map((_, index) => ({ index, relevance_score: 0.9 - index * 0.3 }))
          .reverse(),
      });
    }
    return new Response("not found", { status: 404 });
  },
});

afterAll(() => server.stop(true));

function testConfig(): Config {
  return {
    vault_path: "/unused",
    local_vault_paths: [],
    state_dir: "/unused",
    recall: { k_lexical: 15, k_vector: 15 },
    thresholds: { match_score: 0.9, match_margin: 0.2, candidate_floor: 0.4, candidate_limit: 5 },
    inference: {
      mode: "remote",
      timeout_ms: 2000,
      embedding: { provider: "openai", base_url: `http://127.0.0.1:${server.port}`, api_key_env: "SKILLMUX_TEST_EMBED_KEY", model: "microsoft/harrier-oss-v1-0.6b", dimension: 3 },
      reranker: { provider: "infinity", base_url: `http://127.0.0.1:${server.port}/v1`, model: "BAAI/bge-reranker-v2-m3", api_key_env: "SKILLMUX_TEST_RERANK_KEY" },
      thresholds: { match_score: 0.9, match_margin: 0.2, candidate_floor: 0.4 },
    },
  };
}

describe("embedding client", () => {
  test("posts texts to /v1/embeddings with bearer key and returns one vector per text", async () => {
    process.env.SKILLMUX_TEST_EMBED_KEY = "vk-test-key";
    const clients = createClients(testConfig());
    if (!clients.rerank) throw new Error("expected remote reranker");
    const rerank = clients.rerank;

    const vectors = await clients.embed(["first text", "second text"]);

    expect(vectors).toHaveLength(2);
    expect(vectors[0]).toBeInstanceOf(Float32Array);
    expect(vectors[0]!.length).toBe(3);
    expect(vectors[0]![0]).toBeCloseTo(0.1);
    expect(vectors[1]![0]).toBeCloseTo(0.2);
    const req = requests.find((r) => r.path === "/v1/embeddings")!;
    expect(req.auth).toBe("Bearer vk-test-key");
    expect(req.body).toMatchObject({
      model: "microsoft/harrier-oss-v1-0.6b",
      input: ["first text", "second text"],
    });
  });
});

describe("remote timeout budget (AC7)", () => {
  test("embed rejects when the endpoint exceeds remote_timeout_ms", async () => {
    const config = testConfig();
    if (config.inference.mode !== "remote") throw new Error("expected remote config");
    const clients = createClients({ ...config, inference: { ...config.inference, timeout_ms: 100 } });

    await expect(clients.embed(["slow request"])).rejects.toThrow();
  });
});

describe("rerank client", () => {
  test("posts query and documents to /rerank and returns scores in document order", async () => {
    process.env.SKILLMUX_TEST_RERANK_KEY = "rerank-test-key";
    const clients = createClients(testConfig());
    if (!clients.rerank) throw new Error("expected remote reranker");
    const rerank = clients.rerank;

    const scores = await rerank("route my task", [
      { skill_id: "alpha-skill", text: "Alpha\nfirst description" },
      { skill_id: "beta-skill", text: "Beta\nsecond description" },
    ]);

    expect(scores).toHaveLength(2);
    expect(scores[0]).toBeCloseTo(0.9);
    expect(scores[1]).toBeCloseTo(0.6);
    const req = requests.find((r) => r.path === "/v1/rerank")!;
    expect(req.auth).toBe("Bearer rerank-test-key");
    expect(req.body).toMatchObject({
      model: "BAAI/bge-reranker-v2-m3",
      query: "route my task",
      documents: ["Alpha\nfirst description", "Beta\nsecond description"],
    });
  });
});
