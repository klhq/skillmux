import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diagnose } from "../src/doctor";
import type { Config } from "../src/types";

const server = Bun.serve({
  port: 0,
  fetch: async (req) => {
    const url = new URL(req.url);
    if (url.pathname === "/v1/embeddings") {
      const body = (await req.json()) as { input: string[] };
      return Response.json({
        data: body.input.map((_, index) => ({ index, embedding: [0.1, 0.2, 0.3] })),
      });
    }
    return new Response("not found", { status: 404 });
  },
});

function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    vault_path: "/unused",
    state_dir: mkdtempSync(join(tmpdir(), "doctor-state-")),
    recall: { k_lexical: 15, k_vector: 15 },
    thresholds: { candidate_limit: 5 },
    inference: {
      mode: "remote",
      timeout_ms: 2000,
      embedding: { provider: "openai", base_url: `http://127.0.0.1:${server.port}`, model: "test-model", dimension: 3 },
    },
    ...overrides,
  };
}

describe("diagnose", () => {
  test("reports the vault check as ok when vault_path exists", async () => {
    const vaultDir = mkdtempSync(join(tmpdir(), "doctor-vault-"));

    const report = await diagnose(testConfig({ vault_path: vaultDir }));

    expect(report.checks.find((check) => check.name === "vault")).toMatchObject({ ok: true });

    rmSync(vaultDir, { recursive: true, force: true });
  });

  test("reports the vault check as failing when vault_path does not exist", async () => {
    const report = await diagnose(testConfig({ vault_path: "/definitely/does/not/exist/skillmux-doctor-test" }));

    expect(report.checks.find((check) => check.name === "vault")).toMatchObject({ ok: false });
  });

  test("capability is unavailable when the vault check fails, even if embedding succeeds", async () => {
    const report = await diagnose(testConfig({ vault_path: "/definitely/does/not/exist/skillmux-doctor-test" }));

    expect(report.capability).toBe("unavailable");
  });
});
