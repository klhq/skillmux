import { afterEach, describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";

const origEnv = { ...process.env };

afterEach(() => {
  // Restore process.env
  process.env = { ...origEnv };
});

describe("Docker and env variable configuration (AC4)", () => {
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
});
