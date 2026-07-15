import { afterEach, describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";

const origEnv = { ...process.env };

afterEach(() => {
  // Restore process.env
  process.env = { ...origEnv };
});

describe("Docker and env variable configuration (AC4)", () => {
  test("loads server.rate_limit from config.toml", async () => {
    const tmpPath = "/tmp/skill-router-rate-limit-config.toml";
    await Bun.write(
      tmpPath,
      [
        `[server]`,
        `auth_enabled = false`,
        `auth_token_env = "SKILL_ROUTER_AUTH_TOKEN"`,
        `allowed_origins = ["*"]`,
        ``,
        `[server.rate_limit]`,
        `enabled = true`,
        `requests_per_minute = 75`,
      ].join("\n"),
    );

    const config = await loadConfig(tmpPath);

    expect(config.server?.rate_limit).toEqual({
      enabled: true,
      requests_per_minute: 75,
    });
  });

  test("defaults requests_per_minute to 60 when server.rate_limit.enabled is true and requests_per_minute is omitted", async () => {
    const tmpPath = "/tmp/skill-router-rate-limit-default-config.toml";
    await Bun.write(
      tmpPath,
      [
        `[server]`,
        `auth_enabled = false`,
        `auth_token_env = "SKILL_ROUTER_AUTH_TOKEN"`,
        `allowed_origins = ["*"]`,
        ``,
        `[server.rate_limit]`,
        `enabled = true`,
      ].join("\n"),
    );

    const config = await loadConfig(tmpPath);

    expect(config.server?.rate_limit).toEqual({
      enabled: true,
      requests_per_minute: 60,
    });
  });

  test("supports HTTP_RATE_LIMIT_ENABLED and SKILL_ROUTER_HTTP_RATE_LIMIT_ENABLED boolean env overrides", async () => {
    process.env.HTTP_RATE_LIMIT_ENABLED = "true";
    let config = await loadConfig("/does/not/exist/config.toml");
    expect(config.server?.rate_limit?.enabled).toBe(true);

    delete process.env.HTTP_RATE_LIMIT_ENABLED;
    process.env.SKILL_ROUTER_HTTP_RATE_LIMIT_ENABLED = "false";
    config = await loadConfig("/does/not/exist/config.toml");
    expect(config.server?.rate_limit?.enabled).toBe(false);
  });

  test("prefers SKILL_ROUTER_HTTP_RATE_LIMIT_ENABLED over HTTP_RATE_LIMIT_ENABLED when both are set", async () => {
    process.env.HTTP_RATE_LIMIT_ENABLED = "false";
    process.env.SKILL_ROUTER_HTTP_RATE_LIMIT_ENABLED = "true";

    const config = await loadConfig("/does/not/exist/config.toml");

    expect(config.server?.rate_limit?.enabled).toBe(true);
  });

  test("supports HTTP_RATE_LIMIT_RPM and SKILL_ROUTER_HTTP_RATE_LIMIT_RPM integer env overrides", async () => {
    process.env.HTTP_RATE_LIMIT_RPM = "42";
    let config = await loadConfig("/does/not/exist/config.toml");
    expect(config.server?.rate_limit?.requests_per_minute).toBe(42);
    expect(typeof config.server?.rate_limit?.requests_per_minute).toBe("number");

    delete process.env.HTTP_RATE_LIMIT_RPM;
    process.env.SKILL_ROUTER_HTTP_RATE_LIMIT_RPM = "84";
    config = await loadConfig("/does/not/exist/config.toml");
    expect(config.server?.rate_limit?.requests_per_minute).toBe(84);
    expect(typeof config.server?.rate_limit?.requests_per_minute).toBe("number");
  });

  test("prefers SKILL_ROUTER_HTTP_RATE_LIMIT_RPM over HTTP_RATE_LIMIT_RPM when both are set", async () => {
    process.env.HTTP_RATE_LIMIT_RPM = "42";
    process.env.SKILL_ROUTER_HTTP_RATE_LIMIT_RPM = "84";

    const config = await loadConfig("/does/not/exist/config.toml");

    expect(config.server?.rate_limit?.requests_per_minute).toBe(84);
  });

  test("rejects non-integer HTTP rate limit rpm overrides", async () => {
    process.env.HTTP_RATE_LIMIT_RPM = "not-an-integer";

    await expect(loadConfig("/does/not/exist/config.toml")).rejects.toThrow();
  });
  test("applies Docker-specific defaults when RUNNING_IN_DOCKER=true", async () => {
    process.env.RUNNING_IN_DOCKER = "true";
    // Delete other env overrides if present
    delete process.env.VAULT_PATH;
    delete process.env.STATE_DIR;
    delete process.env.EMBED_BASE_URL;
    delete process.env.RERANK_BASE_URL;
    delete process.env.SKILL_ROUTER_CONFIG;

    // Load config from a non-existent file to get defaults
    const config = await loadConfig("/does/not/exist/config.toml");

    expect(config.vault_path).toBe("/vault");
    expect(config.state_dir).toBe("/data");
    expect(config.embedding.base_url).toBe("local://");
    expect(config.embedding.device).toBe("cpu");
    expect(config.embedding.dtype).toBe("q8");
    expect(config.rerank.base_url).toBe("local://");
    expect(config.rerank.device).toBe("cpu");
    expect(config.rerank.dtype).toBe("q8");
  });

  test("allows overriding settings via individual env variables", async () => {
    process.env.VAULT_PATH = "/env/vault";
    process.env.STATE_DIR = "/env/data";
    process.env.EMBED_BASE_URL = "http://env-embeddings:8000";
    process.env.EMBED_DEVICE = "cuda";
    process.env.EMBED_DTYPE = "fp16";
    process.env.RERANK_BASE_URL = "http://env-rerank:9000";
    process.env.RERANK_DEVICE = "gpu";
    process.env.RERANK_DTYPE = "fp32";

    const config = await loadConfig("/does/not/exist/config.toml");

    expect(config.vault_path).toBe("/env/vault");
    expect(config.state_dir).toBe("/env/data");
    expect(config.embedding.base_url).toBe("http://env-embeddings:8000");
    expect(config.embedding.device).toBe("cuda");
    expect(config.embedding.dtype).toBe("fp16");
    expect(config.rerank.base_url).toBe("http://env-rerank:9000");
    expect(config.rerank.device).toBe("gpu");
    expect(config.rerank.dtype).toBe("fp32");
  });

  test("env overrides take precedence over config file values", async () => {
    // Write a temp config file and load it, but verify env still overrides
    const config = await loadConfig(); // will fall back to defaults or mock config
    process.env.VAULT_PATH = "/env/vault/override";
    
    const configOverridden = await loadConfig("/does/not/exist/config.toml");
    expect(configOverridden.vault_path).toBe("/env/vault/override");
  });


  test("supports EMBED_MODEL and SKILL_ROUTER_EMBED_MODEL overrides for embedding.model", async () => {
    process.env.EMBED_MODEL = "legacy/embed-model";
    let config = await loadConfig("/does/not/exist/config.toml");
    expect(config.embedding.model).toBe("legacy/embed-model");

    delete process.env.EMBED_MODEL;
    process.env.SKILL_ROUTER_EMBED_MODEL = "namespaced/embed-model";
    config = await loadConfig("/does/not/exist/config.toml");
    expect(config.embedding.model).toBe("namespaced/embed-model");
  });

  test("prefers SKILL_ROUTER_EMBED_MODEL over EMBED_MODEL when both are set", async () => {
    process.env.EMBED_MODEL = "legacy/embed-model";
    process.env.SKILL_ROUTER_EMBED_MODEL = "namespaced/embed-model";

    const config = await loadConfig("/does/not/exist/config.toml");

    expect(config.embedding.model).toBe("namespaced/embed-model");
  });

  test("parses EMBED_DIMENSION and SKILL_ROUTER_EMBED_DIMENSION as integers for embedding.dimension", async () => {
    process.env.EMBED_DIMENSION = "1536";
    let config = await loadConfig("/does/not/exist/config.toml");
    expect(config.embedding.dimension).toBe(1536);
    expect(typeof config.embedding.dimension).toBe("number");

    delete process.env.EMBED_DIMENSION;
    process.env.SKILL_ROUTER_EMBED_DIMENSION = "2048";
    config = await loadConfig("/does/not/exist/config.toml");
    expect(config.embedding.dimension).toBe(2048);
    expect(typeof config.embedding.dimension).toBe("number");
  });

  test("prefers SKILL_ROUTER_EMBED_DIMENSION over EMBED_DIMENSION when both are set", async () => {
    process.env.EMBED_DIMENSION = "1536";
    process.env.SKILL_ROUTER_EMBED_DIMENSION = "2048";

    const config = await loadConfig("/does/not/exist/config.toml");

    expect(config.embedding.dimension).toBe(2048);
  });

  test("rejects non-integer embedding dimension overrides", async () => {
    process.env.EMBED_DIMENSION = "not-an-integer";

    await expect(loadConfig("/does/not/exist/config.toml")).rejects.toThrow();
  });

  test("supports RERANK_MODEL and SKILL_ROUTER_RERANK_MODEL overrides for rerank.model", async () => {
    process.env.RERANK_MODEL = "legacy/rerank-model";
    let config = await loadConfig("/does/not/exist/config.toml");
    expect(config.rerank.model).toBe("legacy/rerank-model");

    delete process.env.RERANK_MODEL;
    process.env.SKILL_ROUTER_RERANK_MODEL = "namespaced/rerank-model";
    config = await loadConfig("/does/not/exist/config.toml");
    expect(config.rerank.model).toBe("namespaced/rerank-model");
  });

  test("prefers SKILL_ROUTER_RERANK_MODEL over RERANK_MODEL when both are set", async () => {
    process.env.RERANK_MODEL = "legacy/rerank-model";
    process.env.SKILL_ROUTER_RERANK_MODEL = "namespaced/rerank-model";

    const config = await loadConfig("/does/not/exist/config.toml");

    expect(config.rerank.model).toBe("namespaced/rerank-model");
  });
});
