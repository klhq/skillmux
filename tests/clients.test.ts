import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createClients, RemoteInferenceError } from "../src/clients";
import type { Config, RemoteRerankerConfig } from "../src/types";

const requests: {
  path: string;
  search: string;
  auth: string | null;
  body: unknown;
}[] = [];
const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(
    readFileSync(
      new URL(`./fixtures/reranker/${name}.json`, import.meta.url),
      "utf8",
    ),
  ) as Record<string, unknown>;
const jinaResponse = fixture("jina-v1-response");
const bifrostResponse = fixture("bifrost-v1-response");

const server = Bun.serve({
  port: 0,
  fetch: async (req) => {
    const url = new URL(req.url);
    const body = await req.json();
    requests.push({
      path: url.pathname,
      search: url.search,
      auth: req.headers.get("authorization"),
      body,
    });

    if (
      (body as { input?: string[] }).input?.[0] === "slow request" ||
      (body as { query?: string }).query === "slow request"
    ) {
      await Bun.sleep(500);
    }
    if (url.pathname === "/v1/embeddings") {
      const inputs = (body as { input: string[] }).input;
      return Response.json({
        data: inputs.map((_, index) => ({
          index,
          embedding: [0.1 * (index + 1), 0.2, 0.3],
        })),
      });
    }
    if (url.pathname === "/status") {
      return new Response("secret response body", { status: 503 });
    }
    if (url.pathname === "/malformed") {
      return new Response("{", {
        headers: { "content-type": "application/json" },
      });
    }
    if (url.pathname.startsWith("/invalid/")) {
      const invalid = url.pathname.slice("/invalid/".length);
      const resultByCase: Record<string, unknown[]> = {
        missing: [{ index: 0, relevance_score: 0.9 }],
        duplicate: [
          { index: 0, relevance_score: 0.9 },
          { index: 0, relevance_score: 0.8 },
        ],
        noninteger: [
          { index: 0.5, relevance_score: 0.9 },
          { index: 1, relevance_score: 0.8 },
        ],
        outofrange: [
          { index: 0, relevance_score: 0.9 },
          { index: 2, relevance_score: 0.8 },
        ],
        nonfinite: [
          { index: 0, relevance_score: 0.9 },
          { index: 1, relevance_score: "Infinity" },
        ],
      };
      return Response.json({ results: resultByCase[invalid] });
    }
    if (url.pathname === "/v1/rerank") {
      return Response.json(jinaResponse);
    }
    if (url.pathname === "/v1/bifrost-rerank") {
      return Response.json(bifrostResponse);
    }
    if (url.pathname === "/generated-rerank") {
      const documents = (body as { documents: unknown[] }).documents;
      return Response.json({
        id: "rerank-test",
        model: (body as { model: string }).model,
        results: documents
          .map((_, index) => ({
            index,
            relevance_score: 0.9 - index * 0.3,
          }))
          .reverse(),
      });
    }
    return new Response("not found", { status: 404 });
  },
});

afterAll(() => server.stop(true));
afterEach(() => {
  requests.length = 0;
  delete process.env.SKILLMUX_TEST_EMBED_KEY;
  delete process.env.SKILLMUX_TEST_RERANK_KEY;
});

function testConfig(
  reranker: Partial<RemoteRerankerConfig> = {},
  embeddingApiKeyEnv?: string,
): Config {
  return {
    vault_path: "/unused",
    local_vault_paths: [],
    state_dir: "/unused",
    recall: { k_lexical: 15, k_vector: 15 },
    thresholds: {
      match_score: 0.9,
      match_margin: 0.2,
      candidate_floor: 0.4,
      candidate_limit: 5,
    },
    inference: {
      mode: "remote",
      timeout_ms: 2000,
      embedding: {
        provider: "openai",
        base_url: `http://127.0.0.1:${server.port}`,
        model: "microsoft/harrier-oss-v1-0.6b",
        dimension: 3,
        ...(embeddingApiKeyEnv ? { api_key_env: embeddingApiKeyEnv } : {}),
      },
      reranker: {
        adapter: "jina-v1",
        endpoint: `http://127.0.0.1:${server.port}/v1/rerank`,
        model: "BAAI/bge-reranker-v2-m3",
        ...reranker,
      },
      thresholds: {
        match_score: 0.9,
        match_margin: 0.2,
        candidate_floor: 0.4,
      },
    },
  };
}

const docs = [
  { skill_id: "alpha-skill", text: "Alpha\nfirst description" },
  { skill_id: "beta-skill", text: "Beta\nsecond description" },
];

describe("embedding client", () => {
  test("uses optional Bearer auth and returns vectors", async () => {
    process.env.SKILLMUX_TEST_EMBED_KEY = "vk-test-key";
    const clients = createClients(
      testConfig({}, "SKILLMUX_TEST_EMBED_KEY"),
    );
    const vectors = await clients.embed(["first text", "second text"]);

    expect(vectors).toHaveLength(2);
    expect(vectors[0]).toBeInstanceOf(Float32Array);
    expect(vectors[0]![0]).toBeCloseTo(0.1);
    expect(vectors[1]![0]).toBeCloseTo(0.2);
    expect(requests.at(-1)?.auth).toBe("Bearer vk-test-key");
  });

  test("omitted api_key_env sends no Authorization header", async () => {
    const clients = createClients(testConfig());
    await clients.embed(["text"]);
    expect(requests.at(-1)?.auth).toBeNull();
  });

  test.each([undefined, ""])(
    "named unset or empty credential fails before an embedding request",
    (value) => {
      if (value !== undefined) process.env.SKILLMUX_TEST_EMBED_KEY = value;
      const before = requests.length;
      expect(() =>
        createClients(testConfig({}, "SKILLMUX_TEST_EMBED_KEY")),
      ).toThrow(/SKILLMUX_TEST_EMBED_KEY/);
      expect(requests).toHaveLength(before);
    },
  );

  test("respects the shared timeout", async () => {
    const config = testConfig();
    if (config.inference.mode !== "remote") throw new Error("expected remote");
    config.inference.timeout_ms = 100;
    await expect(createClients(config).embed(["slow request"])).rejects.toThrow();
  });
});

describe("reranker protocol adapters", () => {
  test("jina-v1 preserves the exact endpoint and sends string documents", async () => {
    process.env.SKILLMUX_TEST_RERANK_KEY = "rerank-test-key";
    const clients = createClients(
      testConfig({
        endpoint: `http://127.0.0.1:${server.port}/v1/rerank?route=direct`,
        api_key_env: "SKILLMUX_TEST_RERANK_KEY",
      }),
    );
    const scores = await clients.rerank!("route my task", docs);

    expect(scores).toEqual([0.9, 0.6]);
    expect(requests.at(-1)).toMatchObject({
      path: "/v1/rerank",
      search: "?route=direct",
      auth: "Bearer rerank-test-key",
      body: fixture("jina-v1-request"),
    });
  });

  test("bifrost-v1 sends verified document objects and requests every score", async () => {
    const clients = createClients(
      testConfig({
        adapter: "bifrost-v1",
        endpoint: `http://127.0.0.1:${server.port}/v1/bifrost-rerank`,
        model: "vllm/BAAI/bge-reranker-v2-m3",
      }),
    );
    const scores = await clients.rerank!("route my task", docs);

    expect(scores[0]).toBeCloseTo(0.9);
    expect(scores[1]).toBeCloseTo(0.6);
    expect(requests.at(-1)?.body).toEqual(fixture("bifrost-v1-request"));
  });

  test("omitted api_key_env sends no Authorization header", async () => {
    const clients = createClients(testConfig());
    await clients.rerank!("query", docs);
    expect(requests.at(-1)?.auth).toBeNull();
  });

  test.each([undefined, ""])(
    "named unset or empty credential fails before a reranker request",
    (value) => {
      if (value !== undefined) process.env.SKILLMUX_TEST_RERANK_KEY = value;
      const before = requests.length;
      expect(() =>
        createClients(
          testConfig({ api_key_env: "SKILLMUX_TEST_RERANK_KEY" }),
        ),
      ).toThrow(/SKILLMUX_TEST_RERANK_KEY/);
      expect(requests).toHaveLength(before);
    },
  );

  test.each(["missing", "duplicate", "noninteger", "outofrange", "nonfinite"])(
    "rejects %s indexed results instead of zero-filling",
    async (invalid) => {
      const clients = createClients(
        testConfig({
          endpoint: `http://127.0.0.1:${server.port}/invalid/${invalid}`,
        }),
      );
      await expect(clients.rerank!("query", docs)).rejects.toMatchObject({
        kind: "protocol",
      });
    },
  );

  test("classifies malformed JSON without exposing response data", async () => {
    const clients = createClients(
      testConfig({
        endpoint: `http://127.0.0.1:${server.port}/malformed?token=secret`,
      }),
    );
    const error = await clients.rerank!("query", docs).catch((value) => value);
    expect(error).toBeInstanceOf(RemoteInferenceError);
    expect(error.kind).toBe("protocol");
    expect(error.message).not.toContain("secret");
  });

  test("classifies non-2xx without exposing response bodies", async () => {
    const clients = createClients(
      testConfig({
        endpoint: `http://127.0.0.1:${server.port}/status?token=secret`,
      }),
    );
    const error = await clients.rerank!("query", docs).catch((value) => value);
    expect(error).toMatchObject({ kind: "availability" });
    expect(error.message).toContain("503");
    expect(error.message).not.toContain("secret");
  });

  test("classifies reranker timeouts as availability errors", async () => {
    const config = testConfig();
    if (config.inference.mode !== "remote") throw new Error("expected remote");
    config.inference.timeout_ms = 100;
    const error = await createClients(config)
      .rerank!("slow request", docs)
      .catch((value) => value);
    expect(error).toMatchObject({ kind: "availability" });
  });

  test("classifies reranker transport failures as availability errors", async () => {
    const clients = createClients(
      testConfig({ endpoint: "http://127.0.0.1:1/rerank" }),
    );
    const error = await clients.rerank!("query", docs).catch((value) => value);
    expect(error).toMatchObject({ kind: "availability" });
  });

  test("empty input returns without making an HTTP request", async () => {
    const clients = createClients(testConfig());
    expect(await clients.rerank!("query", [])).toEqual([]);
    expect(requests).toHaveLength(0);
  });
});
