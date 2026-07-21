import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  getDottedKey,
  getEffectiveConfig,
  getLocalConfigStatus,
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
    expect(typeof status.desired_source_hash).toBe("string");
    expect(status.desired_source_hash.length).toBeGreaterThan(0);
  });
});
