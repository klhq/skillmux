import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { loadConfig } from "../src/config";

const originalEnv = { ...process.env };
const files: string[] = [];

async function configFile(content: string): Promise<string> {
  const path = `/tmp/skill-router-config-${crypto.randomUUID()}.toml`;
  files.push(path);
  await Bun.write(path, content);
  return path;
}

afterEach(() => {
  process.env = { ...originalEnv };
  for (const path of files.splice(0)) rmSync(path, { force: true });
});

describe("filesystem defaults", () => {
  test("defaults vault_path to the neutral ~/skills, not the scanned ~/.agents/skills load surface", async () => {
    const config = await loadConfig("/does/not/exist/config.toml");

    expect(config.vault_path).toBe("~/skills");
  });
});

describe("inference configuration", () => {
  test("defaults to the versioned local ONNX bundle", async () => {
    const config = await loadConfig("/does/not/exist/config.toml");

    expect(config.inference).toMatchObject({
      mode: "local",
      bundle: "gte-small-v1",
      models_dir: "~/.cache/skill-router/models",
      embedding: { model: "Xenova/gte-small", dimension: 384, device: "cpu", dtype: "q8" },
    });
  });

  test("Docker changes filesystem defaults but not inference mode", async () => {
    process.env.RUNNING_IN_DOCKER = "true";
    const config = await loadConfig("/does/not/exist/config.toml");

    expect(config.vault_path).toBe("/vault");
    expect(config.state_dir).toBe("/data");
    expect(config.inference.mode).toBe("local");
    if (config.inference.mode === "local") expect(config.inference.models_dir).toBe("/models");
  });

  test("loads an explicit remote OpenAI plus Infinity configuration", async () => {
    const path = await configFile(`
[inference]
mode = "remote"
timeout_ms = 5000

[inference.embedding]
provider = "openai"
base_url = "https://embed.example.com"
model = "example/embed"
dimension = 768
api_key_env = "EMBED_SECRET"

[inference.reranker]
provider = "infinity"
base_url = "https://rerank.example.com"
model = "example/reranker"
api_key_env = "RERANK_SECRET"

[inference.thresholds]
match_score = 0.91
match_margin = 0.21
candidate_floor = 0.41
`);

    const config = await loadConfig(path);
    expect(config.inference).toEqual({
      mode: "remote",
      timeout_ms: 5000,
      embedding: {
        provider: "openai",
        base_url: "https://embed.example.com",
        model: "example/embed",
        dimension: 768,
        api_key_env: "EMBED_SECRET",
      },
      reranker: {
        provider: "infinity",
        base_url: "https://rerank.example.com",
        model: "example/reranker",
        api_key_env: "RERANK_SECRET",
      },
      thresholds: { match_score: 0.91, match_margin: 0.21, candidate_floor: 0.41 },
    });
  });

  test("rejects the unreleased legacy config shape with migration guidance", async () => {
    const path = await configFile(`[embedding]\nbase_url = "http://localhost:8080"\n`);
    await expect(loadConfig(path)).rejects.toThrow("Legacy inference config is not supported");
  });

  test("rejects malformed config values before runtime", async () => {
    const path = await configFile(`[recall]\nk_lexical = "twenty"\n`);
    await expect(loadConfig(path)).rejects.toThrow();
  });

  test("rejects incomplete remote inference", async () => {
    const path = await configFile(`[inference]\nmode = "remote"\ntimeout_ms = 2000\n`);
    await expect(loadConfig(path)).rejects.toThrow("Remote inference requires an inference.embedding");
  });

  test("applies mode-appropriate environment overrides", async () => {
    process.env.EMBED_DEVICE = "cuda";
    process.env.SKILL_ROUTER_MODELS_DIR = "/models-cache";
    let config = await loadConfig("/does/not/exist/config.toml");
    expect(config.inference.mode).toBe("local");
    if (config.inference.mode === "local") {
      expect(config.inference.embedding.device).toBe("cuda");
      expect(config.inference.models_dir).toBe("/models-cache");
    }

    const path = await configFile(`
[inference]
mode = "remote"
timeout_ms = 2000
[inference.embedding]
provider = "openai"
base_url = "https://old.example.com"
model = "old/embed"
dimension = 768
[inference.reranker]
provider = "infinity"
base_url = "https://old-rerank.example.com"
model = "old/reranker"
[inference.thresholds]
match_score = 0.9
match_margin = 0.2
candidate_floor = 0.4
`);
    process.env.SKILL_ROUTER_EMBED_BASE_URL = "https://new.example.com";
    process.env.SKILL_ROUTER_EMBED_MODEL = "new/embed";
    process.env.SKILL_ROUTER_EMBED_DIMENSION = "1024";
    config = await loadConfig(path);
    expect(config.inference.mode).toBe("remote");
    if (config.inference.mode === "remote") {
      expect(config.inference.embedding).toMatchObject({
        base_url: "https://new.example.com",
        model: "new/embed",
        dimension: 1024,
      });
    }
  });

  test("rejects a configured reranker without calibrated thresholds", async () => {
    const path = await configFile(`
[inference]
mode = "remote"
timeout_ms = 2000
[inference.embedding]
provider = "openai"
base_url = "https://embed.example.com"
model = "embed"
dimension = 384
[inference.reranker]
provider = "infinity"
base_url = "https://rerank.example.com"
model = "reranker"
`);
    await expect(loadConfig(path)).rejects.toThrow("requires calibrated inference.thresholds");
  });
});

describe("server configuration", () => {
  test("defaults to loopback-only binding and deny-by-default CORS", async () => {
    const config = await loadConfig("/does/not/exist/config.toml");

    expect(config.server?.hostname).toBe("127.0.0.1");
    expect(config.server?.allowed_origins).toEqual([]);
    expect(config.server?.auth_enabled).toBe(false);
  });

  test("Docker binds 0.0.0.0 so port-mapping can reach the container", async () => {
    process.env.RUNNING_IN_DOCKER = "true";
    const config = await loadConfig("/does/not/exist/config.toml");

    expect(config.server?.hostname).toBe("0.0.0.0");
  });

  test("HTTP_HOSTNAME overrides the configured hostname", async () => {
    process.env.HTTP_HOSTNAME = "0.0.0.0";
    const config = await loadConfig("/does/not/exist/config.toml");

    expect(config.server?.hostname).toBe("0.0.0.0");
  });

  test("loads rate limiting and applies namespaced environment overrides", async () => {
    const path = await configFile(`
[server]
auth_enabled = false
auth_token_env = "SKILL_ROUTER_AUTH_TOKEN"
allowed_origins = ["*"]
[server.rate_limit]
enabled = true
requests_per_minute = 75
`);
    process.env.SKILL_ROUTER_HTTP_RATE_LIMIT_RPM = "84";
    const config = await loadConfig(path);
    expect(config.server?.rate_limit).toEqual({ enabled: true, requests_per_minute: 84 });
  });

  test("SKILL_ROUTER_HTTP_RATE_LIMIT_TRUST_PROXY overrides rate_limit.trust_proxy", async () => {
    const path = await configFile(`
[server]
auth_enabled = false
auth_token_env = "SKILL_ROUTER_AUTH_TOKEN"
allowed_origins = ["*"]
[server.rate_limit]
enabled = true
requests_per_minute = 60
`);
    process.env.SKILL_ROUTER_HTTP_RATE_LIMIT_TRUST_PROXY = "true";
    const config = await loadConfig(path);
    expect(config.server?.rate_limit?.trust_proxy).toBe(true);
  });
});
