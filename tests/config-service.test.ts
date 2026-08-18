import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import packageJson from "../package.json" with { type: "json" };
import {
  getDottedKey,
  getEffectiveConfig,
  getLocalConfigStatus,
  isEnvMasked,
  RELOADABLE_KEYS,
  RESTART_REQUIRED_KEYS,
  setDottedKey,
  validateDottedKey,
  type ConfigSourceMap,
} from "../src/config-service";

const TEST_DIR = join(process.cwd(), ".tmp-test-config-" + Math.random().toString(36).slice(2));
const CONFIG_FILE = join(TEST_DIR, "config.toml");

describe("Config Service (AC4, AC5, AC6)", () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    delete process.env.VAULT_PATH;
    delete process.env.SKILLMUX_MODELS_DIR;
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    process.env = { ...origEnv };
  });

  it("identifies sources as default, toml, or environment (AC4)", async () => {
    writeFileSync(
      CONFIG_FILE,
      `vault_path = "~/custom-vault"\n\n[recall]\nk_lexical = 50\n`,
      "utf-8"
    );
    process.env.VAULT_PATH = "/env/vault";

    const { effective, sources } = await getEffectiveConfig(CONFIG_FILE);
    expect(effective.vault_path).toBe("/env/vault");
    expect(sources["vault_path"]).toBe("environment");
    expect(sources["recall.k_lexical"]).toBe("toml");
    expect(sources["recall.k_vector"]).toBe("default");
    expect(sources["config.environment_overrides"]).toBe("default");
  });

  it("identifies sources as toml when environment_overrides is false", async () => {
    writeFileSync(
      CONFIG_FILE,
      `vault_path = "~/custom-vault"\n\n[config]\nenvironment_overrides = false\n\n[recall]\nk_lexical = 50\n`,
      "utf-8"
    );
    process.env.VAULT_PATH = "/env/vault";
    process.env.SKILLMUX_VAULT_PATH = "/env/vault2";

    const { effective, sources } = await getEffectiveConfig(CONFIG_FILE);
    expect(effective.vault_path).toBe("~/custom-vault");
    expect(sources["vault_path"]).toBe("toml");
    expect(sources["recall.k_lexical"]).toBe("toml");
    expect(sources["config.environment_overrides"]).toBe("toml");
  });

  it("gets and sets valid schema-known dotted keys (AC4)", async () => {
    writeFileSync(CONFIG_FILE, `vault_path = "~/skills"\n`, "utf-8");

    const val = await getDottedKey("recall.k_lexical", CONFIG_FILE);
    expect(val).toBe(20);

    const result = await setDottedKey("recall.k_lexical", "30", { configPath: CONFIG_FILE });
    expect(result.ok).toBe(true);
    expect(result.resulting_val).toBe(30);

    const updatedVal = await getDottedKey("recall.k_lexical", CONFIG_FILE);
    expect(updatedVal).toBe(30);
  });

  it("refuses to set an environment-masked key (AC4)", async () => {
    writeFileSync(CONFIG_FILE, `vault_path = "~/skills"\n`, "utf-8");
    process.env.VAULT_PATH = "/env/vault";

    await expect(
      setDottedKey("vault_path", "~/new-vault", { configPath: CONFIG_FILE })
    ).rejects.toThrow(/environment-masked/i);
  });

  it("rejects unknown dotted keys and invalid value types (AC4)", async () => {
    await expect(
      setDottedKey("unknown.key", "foo", { configPath: CONFIG_FILE })
    ).rejects.toThrow(/unknown/i);

    await expect(
      setDottedKey("recall.k_lexical", "not-a-number", { configPath: CONFIG_FILE })
    ).rejects.toThrow(/numeric/i);
  });

  it("supports dry-run without persisting changes (AC5)", async () => {
    writeFileSync(CONFIG_FILE, `vault_path = "~/skills"\n`, "utf-8");

    const result = await setDottedKey("recall.k_lexical", "40", {
      configPath: CONFIG_FILE,
      dryRun: true,
    });
    expect(result.ok).toBe(true);
    expect(result.persistence).toBe("not_persisted");

    const currentVal = await getDottedKey("recall.k_lexical", CONFIG_FILE);
    expect(currentVal).toBe(20);
  });

  it("reports local config status including hash and runtime=not_running when server inactive (AC6)", async () => {
    const status = await getLocalConfigStatus(CONFIG_FILE);
    expect(status.runtime).toBe("not_running");
    expect(status.version).toBe(packageJson.version);
    expect(status.deployment_runtime).toBe("host");
    expect(status.image_variant).toBeNull();
    expect(typeof status.desired_source_hash).toBe("string");
    expect(status.desired_source_hash.length).toBeGreaterThan(0);
  });

  it("enumerates inference sources, environment masks, and reloadable keys", async () => {
    writeFileSync(
      CONFIG_FILE,
      `[recall]
k_lexical = 50
k_vector = 50
k_rerank = 50
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
`,
      "utf-8",
    );
    process.env.SKILLMUX_RERANK_ENDPOINT =
      "https://gateway.example.com/rerank";
    process.env.SKILLMUX_RERANK_ADAPTER = "bifrost-v1";
    process.env.SKILLMUX_RERANK_MODEL = "vllm/reranker";
    process.env.SKILLMUX_EMBED_ENDPOINT = "https://gateway.example.com/v1/embeddings";
    process.env.SKILLMUX_EMBED_DIMENSION = "512";

    const { effective, sources } = await getEffectiveConfig(CONFIG_FILE);
    expect(effective.inference.mode).toBe("remote");
    if (effective.inference.mode === "remote") {
      expect(effective.inference.reranker).toMatchObject({
        adapter: "bifrost-v1",
        endpoint: "https://gateway.example.com/rerank",
        model: "vllm/reranker",
      });
    }
    expect(sources["inference.reranker.adapter"]).toBe("environment");
    expect(sources["inference.reranker.endpoint"]).toBe("environment");
    expect(sources["inference.reranker.model"]).toBe("environment");
    expect(sources["inference.embedding.endpoint"]).toBe("environment");
    expect(sources["inference.embedding.dimension"]).toBe("environment");
    expect(isEnvMasked("inference.reranker.endpoint")).toBe(true);
    expect(isEnvMasked("inference.embedding.dimension")).toBe(true);
    for (const key of [
      "inference.embedding.endpoint",
      "inference.embedding.api_key_env",
      "inference.reranker.adapter",
      "inference.reranker.endpoint",
      "inference.reranker.model",
      "inference.reranker.api_key_env",
      "inference.timeout_ms",
    ]) {
      validateDottedKey(key);
      expect(RELOADABLE_KEYS).toContain(key);
    }
    for (const key of [
      "inference.embedding.model",
      "inference.embedding.dimension",
      "inference.embedding.device",
      "inference.embedding.dtype",
    ]) {
      expect(RELOADABLE_KEYS).not.toContain(key);
      expect(RESTART_REQUIRED_KEYS).toContain(key);
    }
  });
});
