import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function writeSkillAt(root: string, skillId: string) {
  const dir = join(root, skillId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${skillId}\n---\n\nbody\n`);
}

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

  test("warns when a local_vault_paths entry has no .skillmux marker", async () => {
    const localDir = mkdtempSync(join(tmpdir(), "doctor-local-vault-no-marker-"));

    const report = await diagnose(testConfig({ local_vault_paths: [localDir] }));

    expect(report.checks.find((check) => check.name === `local_vault_marker:${localDir}`)).toMatchObject({
      ok: false,
    });

    rmSync(localDir, { recursive: true, force: true });
  });

  test("reports ok when a local_vault_paths entry's marker matches the configured vault_path", async () => {
    const vaultDir = mkdtempSync(join(tmpdir(), "doctor-vault-for-marker-"));
    const localDir = mkdtempSync(join(tmpdir(), "doctor-local-vault-matching-marker-"));
    writeFileSync(
      join(localDir, ".skillmux"),
      JSON.stringify({ managed_by: "skillmux", role: "local_vault", vault_path: vaultDir, created_at: "2026-01-01T00:00:00.000Z" }),
    );

    const report = await diagnose(testConfig({ vault_path: vaultDir, local_vault_paths: [localDir] }));

    expect(report.checks.find((check) => check.name === `local_vault_marker:${localDir}`)).toMatchObject({
      ok: true,
    });

    rmSync(vaultDir, { recursive: true, force: true });
    rmSync(localDir, { recursive: true, force: true });
  });

  test("warns when a local_vault_paths entry's marker records a different vault_path (drift)", async () => {
    const localDir = mkdtempSync(join(tmpdir(), "doctor-local-vault-drift-marker-"));
    writeFileSync(
      join(localDir, ".skillmux"),
      JSON.stringify({
        managed_by: "skillmux",
        role: "local_vault",
        vault_path: "/some/other/vault",
        created_at: "2026-01-01T00:00:00.000Z",
      }),
    );

    const report = await diagnose(testConfig({ vault_path: "/unused", local_vault_paths: [localDir] }));

    expect(report.checks.find((check) => check.name === `local_vault_marker:${localDir}`)).toMatchObject({
      ok: false,
    });

    rmSync(localDir, { recursive: true, force: true });
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

  test("reports manifest as ok:true 'not yet initialized' when no skillmux.toml exists at vault_path", async () => {
    const vaultDir = mkdtempSync(join(tmpdir(), "doctor-vault-no-manifest-"));

    const report = await diagnose(testConfig({ vault_path: vaultDir }));

    expect(report.checks.find((check) => check.name === "manifest")).toMatchObject({
      ok: true,
      detail: "not yet initialized",
    });

    rmSync(vaultDir, { recursive: true, force: true });
  });

  test("reports a failing manifest check when a skill is pinned in both [core] and a [project.*] group", async () => {
    const vaultDir = mkdtempSync(join(tmpdir(), "doctor-vault-manifest-violation-"));
    writeSkillAt(vaultDir, "shared-skill");
    writeFileSync(
      join(vaultDir, "skillmux.toml"),
      `
[core]
skills = ["shared-skill"]

[project.infra]
paths = []
skills = ["shared-skill"]

[targets.claude]
dir = "~/.claude/skills"
`,
    );

    const report = await diagnose(testConfig({ vault_path: vaultDir }));

    const manifestChecks = report.checks.filter((check) => check.name.startsWith("manifest"));
    expect(manifestChecks).toHaveLength(1);
    expect(manifestChecks[0]).toMatchObject({ ok: false });
    expect(manifestChecks[0]?.detail).toContain("shared-skill");

    rmSync(vaultDir, { recursive: true, force: true });
  });

  test("reports manifest as ok:true with the manifest path when it exists and validates cleanly", async () => {
    const vaultDir = mkdtempSync(join(tmpdir(), "doctor-vault-manifest-healthy-"));
    writeSkillAt(vaultDir, "core-skill");
    writeSkillAt(vaultDir, "infra-skill");
    writeFileSync(
      join(vaultDir, "skillmux.toml"),
      `
[core]
skills = ["core-skill"]

[project.infra]
paths = []
skills = ["infra-skill"]

[targets.claude]
dir = "~/.claude/skills"
`,
    );

    const report = await diagnose(testConfig({ vault_path: vaultDir }));

    expect(report.checks.find((check) => check.name === "manifest")).toMatchObject({
      ok: true,
      detail: join(vaultDir, "skillmux.toml"),
    });

    rmSync(vaultDir, { recursive: true, force: true });
  });

  test("never writes to the manifest file while diagnosing", async () => {
    const vaultDir = mkdtempSync(join(tmpdir(), "doctor-vault-manifest-readonly-"));
    writeSkillAt(vaultDir, "core-skill");
    const manifestPath = join(vaultDir, "skillmux.toml");
    const original = `
[core]
skills = ["core-skill"]

[targets.claude]
dir = "~/.claude/skills"
`;
    writeFileSync(manifestPath, original);

    await diagnose(testConfig({ vault_path: vaultDir }));

    expect(readFileSync(manifestPath, "utf8")).toBe(original);

    rmSync(vaultDir, { recursive: true, force: true });
  });
});
