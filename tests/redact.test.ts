import { afterEach, describe, expect, test } from "bun:test";
import { buildRedactor } from "../src/redact";
import { redactedErrorLog } from "../src/logger";
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

  test("should be a no-op when the config has no *_env keys set", () => {
    const config = testConfig();
    const redact = buildRedactor(config);
    const text = "plain error: connection refused to https://host/repo.git";

    expect(redact(text)).toBe(text);
  });

  test("should scrub userinfo credentials embedded in a URL, independent of config", () => {
    const redact = buildRedactor(testConfig());
    const out = redact(
      "git clone failed for https://user:supersecret123@host/repo.git: fatal: repository not found",
    );

    expect(out).not.toContain("supersecret123");
    expect(out).toContain("[REDACTED]");
    expect(out).toContain("host/repo.git");
  });

  test("should be a synchronous, deterministic pure function needing no network or subprocess", () => {
    process.env.SKILLMUX_TEST_REDACT_KEY = "purity-secret";
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
    const result = redact("leaked purity-secret value");

    expect(result).not.toBeInstanceOf(Promise);
    expect(redact("leaked purity-secret value")).toBe(result);
  });
});

describe("redactedErrorLog", () => {
  test("should redact the error's message through the given redactor before pairing it with the prefix", () => {
    const redact = buildRedactor(testConfig());
    const err = new Error("git clone failed for https://user:topsecret@host/repo.git");

    const [prefix, message] = redactedErrorLog("skillmux runtime init error:", err, redact);

    expect(prefix).toBe("skillmux runtime init error:");
    expect(message).not.toContain("topsecret");
    expect(message).toContain("[REDACTED]");
  });

  test("should stringify a non-Error thrown value before redacting", () => {
    const redact = buildRedactor(testConfig());
    const [, message] = redactedErrorLog("skillmux audit prune error:", "plain string failure", redact);

    expect(message).toBe("plain string failure");
  });
});
