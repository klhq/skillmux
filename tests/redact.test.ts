import { afterEach, describe, expect, test } from "bun:test";
import { buildRedactor } from "../src/redact";
import type { Config } from "../src/types";

function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    vault_path: "/unused",
    local_vault_paths: [],
    state_dir: "/unused",
    recall: { k_lexical: 15, k_vector: 15, k_rerank: 10 },
    output: { top_k: 10, max_top_k: 50 },
    inference: {
      mode: "remote",
      timeout_ms: 2000,
      embedding: {
        provider: "openai",
        endpoint: "http://127.0.0.1:1/v1/embeddings",
        model: "microsoft/harrier-oss-v1-0.6b",
        dimension: 3,
      },
    },
    ...overrides,
  };
}

describe("buildRedactor", () => {
  afterEach(() => {
    delete process.env.SKILLMUX_TEST_REDACT_KEY;
  });

  test("should scrub the resolved value of a *_env config key from text", () => {
    process.env.SKILLMUX_TEST_REDACT_KEY = "supersecret123";
    const config = testConfig({
      inference: {
        mode: "remote",
        timeout_ms: 2000,
        embedding: {
          provider: "openai",
          endpoint: "http://127.0.0.1:1/v1/embeddings",
          model: "microsoft/harrier-oss-v1-0.6b",
          dimension: 3,
          api_key_env: "SKILLMUX_TEST_REDACT_KEY",
        },
      },
    });

    const redact = buildRedactor(config);
    const out = redact("git clone failed: https://user:supersecret123@host/repo.git");

    expect(out).not.toContain("supersecret123");
    expect(out).toContain("[REDACTED]");
  });
});
