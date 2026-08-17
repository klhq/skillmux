import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mock } from "bun:test";

let fakeHome = `/tmp/fake-home-migration-${crypto.randomUUID()}`;

mock.module("node:os", () => {
  return {
    homedir: () => fakeHome,
    tmpdir: () => "/tmp",
  };
});

import { loadConfig, migrateLegacyPaths, warnedEnv } from "../src/config";

const originalEnv = { ...process.env };
const files: string[] = [];

async function configFile(content: string): Promise<string> {
  const path = `/tmp/skillmux-config-${crypto.randomUUID()}.toml`;
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

  test("defaults local_vault_paths to an empty array", async () => {
    const config = await loadConfig("/does/not/exist/config.toml");

    expect(config.local_vault_paths).toEqual([]);
  });

  test("loads configured local_vault_paths alongside the unchanged vault_path", async () => {
    const path = await configFile(`
vault_path = "~/skills"
local_vault_paths = ["~/skills-local", "~/skills-experimental"]
`);

    const config = await loadConfig(path);

    expect(config.vault_path).toBe("~/skills");
    expect(config.local_vault_paths).toEqual(["~/skills-local", "~/skills-experimental"]);
  });
});

describe("inference configuration", () => {
  test("defaults to the versioned local ONNX bundle", async () => {
    const config = await loadConfig("/does/not/exist/config.toml");

    expect(config.inference).toMatchObject({
      mode: "local",
      bundle: "gte-small-v1",
      models_dir: "~/.cache/skillmux/models",
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

  test("loads OpenAI embeddings plus an explicit reranker adapter", async () => {
    process.env.EMBED_SECRET = "embed-token";
    process.env.RERANK_SECRET = "rerank-token";
    const path = await configFile(`
[inference]
mode = "remote"
timeout_ms = 5000

[inference.embedding]
provider = "openai"
endpoint = "https://embed.example.com/v1/embeddings"
model = "example/embed"
dimension = 768
api_key_env = "EMBED_SECRET"

[inference.reranker]
adapter = "jina-v1"
endpoint = "https://rerank.example.com/v1/rerank"
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
        endpoint: "https://embed.example.com/v1/embeddings",
        model: "example/embed",
        dimension: 768,
        api_key_env: "EMBED_SECRET",
      },
      reranker: {
        adapter: "jina-v1",
        endpoint: "https://rerank.example.com/v1/rerank",
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
    process.env.SKILLMUX_MODELS_DIR = "/models-cache";
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
endpoint = "https://old.example.com/v1/embeddings"
model = "old/embed"
dimension = 768
[inference.reranker]
adapter = "jina-v1"
endpoint = "https://old-rerank.example.com/rerank"
model = "old/reranker"
[inference.thresholds]
match_score = 0.9
match_margin = 0.2
candidate_floor = 0.4
`);
    process.env.SKILLMUX_EMBED_ENDPOINT = "https://new.example.com/v1/embeddings";
    process.env.SKILLMUX_EMBED_MODEL = "new/embed";
    process.env.SKILLMUX_EMBED_DIMENSION = "1024";
    process.env.SKILLMUX_RERANK_ENDPOINT = "https://new-rerank.example.com/v1/rerank";
    process.env.SKILLMUX_RERANK_ADAPTER = "bifrost-v1";
    process.env.SKILLMUX_RERANK_MODEL = "vllm/new-reranker";
    config = await loadConfig(path);
    expect(config.inference.mode).toBe("remote");
    if (config.inference.mode === "remote") {
      expect(config.inference.embedding).toMatchObject({
        endpoint: "https://new.example.com/v1/embeddings",
        model: "new/embed",
        dimension: 1024,
      });
      expect(config.inference.reranker).toMatchObject({
        adapter: "bifrost-v1",
        endpoint: "https://new-rerank.example.com/v1/rerank",
        model: "vllm/new-reranker",
      });
    }
  });

  test("does not create a reranker from environment overrides", async () => {
    const path = await configFile(`
[inference]
mode = "remote"
timeout_ms = 2000
[inference.embedding]
provider = "openai"
endpoint = "https://embed.example.com/v1/embeddings"
model = "embed"
dimension = 384
`);
    process.env.SKILLMUX_RERANK_ENDPOINT = "https://rerank.example.com/v1/rerank";
    process.env.SKILLMUX_RERANK_ADAPTER = "jina-v1";
    process.env.SKILLMUX_RERANK_MODEL = "reranker";

    const config = await loadConfig(path);
    expect(config.inference.mode).toBe("remote");
    if (config.inference.mode === "remote") {
      expect(config.inference.reranker).toBeUndefined();
    }
  });

  test("rejects an unknown adapter supplied by environment", async () => {
    const path = await configFile(`
[inference]
mode = "remote"
timeout_ms = 2000
[inference.embedding]
provider = "openai"
endpoint = "https://embed.example.com/v1/embeddings"
model = "embed"
dimension = 384
[inference.reranker]
adapter = "jina-v1"
endpoint = "https://rerank.example.com/v1/rerank"
model = "reranker"
[inference.thresholds]
match_score = 0.9
match_margin = 0.2
candidate_floor = 0.4
`);
    process.env.SKILLMUX_RERANK_ADAPTER = "unknown-v1";
    await expect(loadConfig(path)).rejects.toThrow();
  });

  test("rejects removed reranker TOML fields with migration guidance", async () => {
    const path = await configFile(`
[inference]
mode = "remote"
timeout_ms = 2000
[inference.embedding]
provider = "openai"
endpoint = "https://embed.example.com/v1/embeddings"
model = "embed"
dimension = 384
[inference.reranker]
provider = "infinity"
base_url = "https://rerank.example.com/v1"
model = "reranker"
`);
    await expect(loadConfig(path)).rejects.toThrow(/complete endpoint URL.*appended \/rerank/i);
  });

  test("rejects removed embedding base_url TOML with targeted migration guidance", async () => {
    const path = await configFile(`
[inference]
mode = "remote"
timeout_ms = 2000
[inference.embedding]
provider = "openai"
base_url = "https://embed.example.com"
model = "embed"
dimension = 384
`);
    await expect(loadConfig(path)).rejects.toThrow(/inference\.embedding\.endpoint.*complete/i);
  });

  test.each([
    "SKILLMUX_RERANK_BASE_URL",
    "SKILL_ROUTER_RERANK_BASE_URL",
    "RERANK_BASE_URL",
  ])("rejects removed environment variable %s", async (name) => {
    process.env[name] = "https://rerank.example.com/v1";
    await expect(loadConfig("/does/not/exist/config.toml")).rejects.toThrow(
      new RegExp(name),
    );
  });

  test.each([
    "ftp://rerank.example.com/v1/rerank",
    "https://user:password@rerank.example.com/v1/rerank",
    "https://rerank.example.com/v1/rerank#fragment",
  ])("rejects unsafe reranker endpoint %s", async (endpoint) => {
    const path = await configFile(`
[inference]
mode = "remote"
timeout_ms = 2000
[inference.embedding]
provider = "openai"
endpoint = "https://embed.example.com/v1/embeddings"
model = "embed"
dimension = 384
[inference.reranker]
adapter = "jina-v1"
endpoint = "${endpoint}"
model = "reranker"
[inference.thresholds]
match_score = 0.9
match_margin = 0.2
candidate_floor = 0.4
`);
    await expect(loadConfig(path)).rejects.toThrow(/without userinfo or a fragment/);
  });

  test.each([
    "ftp://embed.example.com/v1/embeddings",
    "https://user:password@embed.example.com/v1/embeddings",
    "https://embed.example.com/v1/embeddings#fragment",
  ])("rejects unsafe embedding endpoint %s", async (endpoint) => {
    const path = await configFile(`
[inference]
mode = "remote"
timeout_ms = 2000
[inference.embedding]
provider = "openai"
endpoint = "${endpoint}"
model = "embed"
dimension = 384
`);
    await expect(loadConfig(path)).rejects.toThrow(/without userinfo or a fragment/);
  });

  test.each([
    ["EMBED_SECRET", "inference.embedding.api_key_env"],
    ["RERANK_SECRET", "inference.reranker.api_key_env"],
  ])("rejects unset or empty named credential %s", async (envName, configKey) => {
    const path = await configFile(`
[inference]
mode = "remote"
timeout_ms = 2000
[inference.embedding]
provider = "openai"
endpoint = "https://embed.example.com/v1/embeddings"
model = "embed"
dimension = 384
${configKey === "inference.embedding.api_key_env" ? `api_key_env = "${envName}"` : ""}
[inference.reranker]
adapter = "jina-v1"
endpoint = "https://rerank.example.com/v1/rerank"
model = "reranker"
${configKey === "inference.reranker.api_key_env" ? `api_key_env = "${envName}"` : ""}
[inference.thresholds]
match_score = 0.9
match_margin = 0.2
candidate_floor = 0.4
`);
    await expect(loadConfig(path)).rejects.toThrow(new RegExp(envName));
    process.env[envName] = "";
    await expect(loadConfig(path)).rejects.toThrow(new RegExp(envName));
  });

  test("warns but loads a configured reranker without calibrated thresholds", async () => {
    const path = await configFile(`
[inference]
mode = "remote"
timeout_ms = 2000
[inference.embedding]
provider = "openai"
endpoint = "https://embed.example.com/v1/embeddings"
model = "embed"
dimension = 384
[inference.reranker]
adapter = "jina-v1"
endpoint = "https://rerank.example.com/v1/rerank"
model = "reranker"
`);
    const warningKey = "inference.reranker.without-thresholds";
    warnedEnv.delete(warningKey);
    const originalError = console.error;
    const warnings: string[] = [];
    console.error = (...args: unknown[]) => warnings.push(args.join(" "));
    try {
      const config = await loadConfig(path);
      expect(config.inference.mode).toBe("remote");
      if (config.inference.mode !== "remote") throw new Error("expected remote config");
      expect(config.inference.reranker).toBeDefined();
      expect(config.inference.thresholds).toBeUndefined();
      expect(warnings).toEqual([
        expect.stringContaining("skillmux calibrate run"),
      ]);
    } finally {
      console.error = originalError;
      warnedEnv.delete(warningKey);
    }
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
auth_token_env = "SKILLMUX_AUTH_TOKEN"
allowed_origins = ["*"]
[server.rate_limit]
enabled = true
requests_per_minute = 75
`);
    process.env.SKILLMUX_HTTP_RATE_LIMIT_RPM = "84";
    const config = await loadConfig(path);
    expect(config.server?.rate_limit).toEqual({ enabled: true, requests_per_minute: 84 });
  });

  test("SKILLMUX_HTTP_RATE_LIMIT_TRUST_PROXY overrides rate_limit.trust_proxy", async () => {
    const path = await configFile(`
[server]
auth_enabled = false
auth_token_env = "SKILLMUX_AUTH_TOKEN"
allowed_origins = ["*"]
[server.rate_limit]
enabled = true
requests_per_minute = 60
`);
    process.env.SKILLMUX_HTTP_RATE_LIMIT_TRUST_PROXY = "true";
    const config = await loadConfig(path);
    expect(config.server?.rate_limit?.trust_proxy).toBe(true);
  });
});

describe("Shim 1: legacy XDG directory migration", () => {
  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
  });

  test("migrates directories when only legacy exists", () => {
    mkdirSync(join(fakeHome, ".config/skill-router"), { recursive: true });
    mkdirSync(join(fakeHome, ".local/state/skill-router"), { recursive: true });
    mkdirSync(join(fakeHome, ".cache/skill-router"), { recursive: true });
    writeFileSync(join(fakeHome, ".config/skill-router/config.toml"), "legacy-config");
    writeFileSync(join(fakeHome, ".local/state/skill-router/audit.db"), "legacy-db");

    migrateLegacyPaths();

    expect(existsSync(join(fakeHome, ".config/skillmux/config.toml"))).toBe(true);
    expect(existsSync(join(fakeHome, ".local/state/skillmux/audit.db"))).toBe(true);
    expect(existsSync(join(fakeHome, ".cache/skillmux"))).toBe(true);
    expect(existsSync(join(fakeHome, ".config/skill-router"))).toBe(false);
  });

  test("no-ops when new directories already exist", () => {
    mkdirSync(join(fakeHome, ".config/skill-router"), { recursive: true });
    writeFileSync(join(fakeHome, ".config/skill-router/config.toml"), "legacy-config");

    mkdirSync(join(fakeHome, ".config/skillmux"), { recursive: true });
    writeFileSync(join(fakeHome, ".config/skillmux/config.toml"), "new-config");

    migrateLegacyPaths();

    expect(readFileSync(join(fakeHome, ".config/skillmux/config.toml"), "utf-8")).toBe("new-config");
    expect(existsSync(join(fakeHome, ".config/skill-router/config.toml"))).toBe(true);
  });

  test("no-ops when legacy directories do not exist", () => {
    migrateLegacyPaths();
    expect(existsSync(join(fakeHome, ".config/skillmux"))).toBe(false);
  });
});

describe("Shim 2: legacy environment variable fallbacks", () => {
  let consoleErrorSpy: any;
  const originalConsoleError = console.error;

  beforeEach(() => {
    warnedEnv.clear();
    consoleErrorSpy = [];
    console.error = (...args: any[]) => {
      consoleErrorSpy.push(args.join(" "));
    };
  });

  afterEach(() => {
    console.error = originalConsoleError;
  });

  test("SKILLMUX_CONFIG primary var works without warning", async () => {
    const configPath = await configFile("[recall]\nk_lexical = 10\n");
    process.env.SKILLMUX_CONFIG = configPath;
    
    const config = await loadConfig();
    expect(config.recall.k_lexical).toBe(10);
    expect(consoleErrorSpy.length).toBe(0);
  });

  test("SKILL_ROUTER_CONFIG fallback works with deprecation warning", async () => {
    const configPath = await configFile("[recall]\nk_lexical = 12\n");
    process.env.SKILL_ROUTER_CONFIG = configPath;
    
    const config = await loadConfig();
    expect(config.recall.k_lexical).toBe(12);
    expect(consoleErrorSpy.some((msg: string) => msg.includes("SKILL_ROUTER_CONFIG is deprecated"))).toBe(true);
  });

  test("SKILL_ROUTER_MODELS_DIR fallback works with deprecation warning", async () => {
    process.env.SKILL_ROUTER_MODELS_DIR = "/legacy-models-path";
    const config = await loadConfig();
    expect(config.inference.mode === "local" ? config.inference.models_dir : "").toBe("/legacy-models-path");
    expect(consoleErrorSpy.some((msg: string) => msg.includes("SKILL_ROUTER_MODELS_DIR is deprecated"))).toBe(true);
  });

  test("removed embedding base-url environment variables provide targeted migration guidance", async () => {
    const path = await configFile(`
[inference]
mode = "remote"
timeout_ms = 2000
[inference.embedding]
provider = "openai"
endpoint = "https://default.example.com/v1/embeddings"
model = "embed"
dimension = 384
`);
    process.env.SKILL_ROUTER_EMBED_BASE_URL = "https://legacy-embed.example.com";
    await expect(loadConfig(path)).rejects.toThrow(/inference\.embedding\.endpoint/);
  });
});

describe("Configuration Authority & environment_overrides policy", () => {
  let consoleErrorSpy: string[];
  const originalConsoleError = console.error;

  beforeEach(() => {
    warnedEnv.clear();
    consoleErrorSpy = [];
    console.error = (...args: any[]) => {
      consoleErrorSpy.push(args.join(" "));
    };
  });

  afterEach(() => {
    console.error = originalConsoleError;
  });

  test("defaults config.environment_overrides to true", async () => {
    const config = await loadConfig("/does/not/exist/config.toml");
    expect(config.config?.environment_overrides).toBe(true);
  });

  test("when environment_overrides is true, SKILLMUX_* overrides TOML", async () => {
    const path = await configFile(`
[config]
environment_overrides = true

[inference]
mode = "remote"
timeout_ms = 2000

[inference.embedding]
provider = "openai"
endpoint = "https://embed.example.com/v1/embeddings"
model = "toml-model"
dimension = 384
`);
    process.env.SKILLMUX_EMBED_MODEL = "env-model";
    const config = await loadConfig(path);
    expect(config.inference.mode === "remote" && config.inference.embedding.model).toBe("env-model");
  });

  test("when environment_overrides is false, behavioral SKILLMUX_* and generic env vars do not override TOML", async () => {
    const path = await configFile(`
[config]
environment_overrides = false

[inference]
mode = "remote"
timeout_ms = 2000

[inference.embedding]
provider = "openai"
endpoint = "https://embed.example.com/v1/embeddings"
model = "toml-model"
dimension = 384
`);
    process.env.SKILLMUX_EMBED_MODEL = "env-model";
    process.env.EMBED_MODEL = "generic-model";
    process.env.VAULT_PATH = "/env/vault";
    process.env.STATE_DIR = "/env/state";

    const config = await loadConfig(path);
    expect(config.inference.mode === "remote" && config.inference.embedding.model).toBe("toml-model");
    expect(config.vault_path).toBe("~/skills");
    expect(config.state_dir).toBe("~/.local/state/skillmux");
    expect(consoleErrorSpy.some((msg) => msg.includes("EMBED_MODEL is deprecated"))).toBe(true);
  });

  test("when environment_overrides is false, api_key_env secret resolution still succeeds", async () => {
    process.env.MY_SECRET_KEY = "super-secret";
    const path = await configFile(`
[config]
environment_overrides = false

[inference]
mode = "remote"
timeout_ms = 2000

[inference.embedding]
provider = "openai"
endpoint = "https://embed.example.com/v1/embeddings"
model = "toml-model"
dimension = 384
api_key_env = "MY_SECRET_KEY"
`);
    const config = await loadConfig(path);
    expect(config.inference.mode === "remote" && config.inference.embedding.api_key_env).toBe("MY_SECRET_KEY");
  });

  test("generic EMBED_* and RERANK_* env vars trigger deprecation warning in 1.x", async () => {
    const path = await configFile(`
[inference]
mode = "remote"
timeout_ms = 2000

[inference.embedding]
provider = "openai"
endpoint = "https://embed.example.com/v1/embeddings"
model = "toml-model"
dimension = 384
`);
    process.env.EMBED_MODEL = "generic-embed-model";
    const config = await loadConfig(path);
    expect(config.inference.mode === "remote" && config.inference.embedding.model).toBe("generic-embed-model");
    expect(consoleErrorSpy.some((msg) => msg.includes("EMBED_MODEL is deprecated"))).toBe(true);
  });
});

describe("recall.k_rerank budget configuration", () => {
  test("defaults k_rerank when not explicitly provided in TOML", async () => {
    const path = await configFile(`
[recall]
k_lexical = 15
k_vector = 15
`);
    const config = await loadConfig(path);
    expect(config.recall.k_rerank).toBeDefined();
    expect(config.recall.k_rerank).toBeGreaterThan(0);
    expect(config.recall.k_rerank).toBeLessThanOrEqual(config.recall.k_lexical + config.recall.k_vector);
  });

  test("loads explicit recall.k_rerank from TOML", async () => {
    const path = await configFile(`
[recall]
k_lexical = 15
k_vector = 15
k_rerank = 5
`);
    const config = await loadConfig(path);
    expect(config.recall.k_rerank).toBe(5);
  });

  test("rejects k_rerank exceeding k_lexical + k_vector", async () => {
    const path = await configFile(`
[recall]
k_lexical = 2
k_vector = 2
k_rerank = 5
`);
    await expect(loadConfig(path)).rejects.toThrow(/recall\.k_rerank/);
  });

  test("rejects non-positive k_rerank", async () => {
    const path = await configFile(`
[recall]
k_lexical = 15
k_vector = 15
k_rerank = 0
`);
    await expect(loadConfig(path)).rejects.toThrow();
  });
});


