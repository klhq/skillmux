import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    local_vault_paths: [],
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

  test("reports each local_vault_paths entry's existence status", async () => {
    const existingLocal = mkdtempSync(join(tmpdir(), "doctor-local-vault-"));
    const missingLocal = "/definitely/does/not/exist/skillmux-doctor-local-vault";

    const report = await diagnose(testConfig({ local_vault_paths: [existingLocal, missingLocal] }));

    expect(report.checks.find((check) => check.name === `local_vault:${existingLocal}`)).toMatchObject({ ok: true });
    expect(report.checks.find((check) => check.name === `local_vault:${missingLocal}`)).toMatchObject({ ok: false });

    rmSync(existingLocal, { recursive: true, force: true });
  });

  test("warns when a local_vault_paths entry contains a stray skillmux.toml manifest", async () => {
    const localWithManifest = mkdtempSync(join(tmpdir(), "doctor-local-vault-stray-"));
    writeFileSync(join(localWithManifest, "skillmux.toml"), "core = { skills = [] }");

    const report = await diagnose(testConfig({ local_vault_paths: [localWithManifest] }));

    expect(report.checks.find((check) => check.name === `local_vault_manifest:${localWithManifest}`)).toMatchObject({
      ok: false,
    });

    rmSync(localWithManifest, { recursive: true, force: true });
  });

  test("reports a shadowed skill when a local_vault_paths entry overrides a vault_path skill", async () => {
    const vaultDir = mkdtempSync(join(tmpdir(), "doctor-vault-"));
    const localDir = mkdtempSync(join(tmpdir(), "doctor-local-vault-"));
    for (const [root, description] of [
      [vaultDir, "upstream"],
      [localDir, "local override"],
    ] as const) {
      mkdirSync(join(root, "shared-skill"), { recursive: true });
      writeFileSync(
        join(root, "shared-skill", "SKILL.md"),
        `---\nname: shared-skill\ndescription: ${description}\n---\n\nbody\n`,
      );
    }

    const report = await diagnose(testConfig({ vault_path: vaultDir, local_vault_paths: [localDir] }));

    expect(report.checks.find((check) => check.name === "shadowed:shared-skill")).toMatchObject({
      ok: true,
      detail: `served from ${localDir}; shadows ${vaultDir}`,
    });

    rmSync(vaultDir, { recursive: true, force: true });
    rmSync(localDir, { recursive: true, force: true });
  });
});
