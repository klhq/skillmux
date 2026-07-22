import { describe, expect, test } from "bun:test";
import { parseManifest, resolveManifestPath, serializeManifest, validateManifest } from "../src/manifest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function tmpVault(): string {
  return mkdtempSync(join(tmpdir(), "skillmux-manifest-vault-"));
}

function writeSkillAt(root: string, skillId: string) {
  const dir = join(root, skillId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${skillId}\n---\n\nbody\n`);
}

describe("parseManifest", () => {
  test("parses a valid skillmux.toml into typed core/project/targets", () => {
    const toml = `
[core]
skills = ["writing-clearly", "code-review"]

[project.infra]
repos = ["~/workspace/infra"]
skills = ["terraform-plans"]

[targets.claude]
dir = "~/.claude/skills"
project_groups = ["infra"]
`;
    const manifest = parseManifest(toml);
    expect(manifest).toEqual({
      core: { skills: ["writing-clearly", "code-review"] },
      project: { infra: { repos: ["~/workspace/infra"], skills: ["terraform-plans"] } },
      targets: { claude: { dir: "~/.claude/skills", project_groups: ["infra"] } },
    });
  });

  test("rejects the removed [targets.*].project boolean field", () => {
    const toml = `
[core]
skills = []

[targets.claude]
dir = "~/.claude/skills"
project = true
`;
    expect(() => parseManifest(toml)).toThrow(/project_groups/);
  });

  test("rejects a manifest missing the required [core] section", () => {
    const toml = `
[targets.claude]
dir = "~/.claude/skills"
`;
    expect(() => parseManifest(toml)).toThrow();
  });

  test("rejects a core skill id that violates the skill id pattern", () => {
    const toml = `
[core]
skills = ["Invalid_ID"]

[targets.claude]
dir = "~/.claude/skills"
`;
    expect(() => parseManifest(toml)).toThrow();
  });
});

describe("validateManifest", () => {
  test("throws naming a core skill that does not exist in the vault", () => {
    const vaultPath = tmpVault();
    writeSkillAt(vaultPath, "writing-clearly");
    const manifest = parseManifest(`
[core]
skills = ["ghost-skill"]

[targets.claude]
dir = "~/.claude/skills"
`);
    expect(() => validateManifest(manifest, vaultPath)).toThrow("ghost-skill");

    rmSync(vaultPath, { recursive: true, force: true });
  });

  test("throws naming a skill listed in both [core] and a [project.*] group", () => {
    const vaultPath = tmpVault();
    writeSkillAt(vaultPath, "shared-skill");
    const manifest = parseManifest(`
[core]
skills = ["shared-skill"]

[project.infra]
repos = []
skills = ["shared-skill"]

[targets.claude]
dir = "~/.claude/skills"
`);
    expect(() => validateManifest(manifest, vaultPath)).toThrow("shared-skill");

    rmSync(vaultPath, { recursive: true, force: true });
  });

  test("passes for a manifest whose skills all exist and don't overlap", () => {
    const vaultPath = tmpVault();
    writeSkillAt(vaultPath, "core-skill");
    writeSkillAt(vaultPath, "infra-skill");
    const manifest = parseManifest(`
[core]
skills = ["core-skill"]

[project.infra]
repos = []
skills = ["infra-skill"]

[targets.claude]
dir = "~/.claude/skills"
`);
    const result = validateManifest(manifest, vaultPath);
    expect(result.notes).toEqual([]);

    rmSync(vaultPath, { recursive: true, force: true });
  });

  test("throws naming the count when [core] exceeds 25 skills", () => {
    const vaultPath = tmpVault();
    const skillIds = Array.from({ length: 26 }, (_, i) => `skill-${i}`);
    for (const skillId of skillIds) writeSkillAt(vaultPath, skillId);
    const manifest = parseManifest(`
[core]
skills = ${JSON.stringify(skillIds)}

[targets.claude]
dir = "~/.claude/skills"
`);
    expect(() => validateManifest(manifest, vaultPath)).toThrow("26");

    rmSync(vaultPath, { recursive: true, force: true });
  });

  test("throws when a target's project_groups references an undefined [project.*] group", () => {
    const vaultPath = tmpVault();
    const manifest = parseManifest(`
[core]
skills = []

[project.infra]
repos = []
skills = []

[targets.claude]
dir = "~/.claude/skills"
project_groups = ["nonexistent"]
`);
    expect(() => validateManifest(manifest, vaultPath)).toThrow("nonexistent");

    rmSync(vaultPath, { recursive: true, force: true });
  });

  test("skips a [project.*].repos path that doesn't exist locally with a note, not an error", () => {
    const vaultPath = tmpVault();
    const manifest = parseManifest(`
[core]
skills = []

[project.infra]
repos = ["/does/not/exist/on/this/machine"]
skills = []

[targets.claude]
dir = "~/.claude/skills"
`);
    const result = validateManifest(manifest, vaultPath);
    expect(result.notes).toEqual(["[project.infra] repos path not found locally, skipped: /does/not/exist/on/this/machine"]);

    rmSync(vaultPath, { recursive: true, force: true });
  });

  test("throws when a [core] skill only resolves from a local_vault_paths entry, not vault_path (AC6)", () => {
    const vaultPath = tmpVault();
    const localVault = tmpVault();
    writeSkillAt(localVault, "local-only-skill");
    const manifest = parseManifest(`
[core]
skills = ["local-only-skill"]

[targets.claude]
dir = "~/.claude/skills"
`);
    expect(() => validateManifest(manifest, vaultPath, [localVault])).toThrow("local-only-skill");

    rmSync(vaultPath, { recursive: true, force: true });
    rmSync(localVault, { recursive: true, force: true });
  });

  test("throws when a [project.*] skill only resolves from a local_vault_paths entry, not vault_path (AC6)", () => {
    const vaultPath = tmpVault();
    const localVault = tmpVault();
    writeSkillAt(localVault, "local-only-skill");
    const manifest = parseManifest(`
[core]
skills = []

[project.infra]
repos = []
skills = ["local-only-skill"]

[targets.claude]
dir = "~/.claude/skills"
`);
    expect(() => validateManifest(manifest, vaultPath, [localVault])).toThrow("local-only-skill");

    rmSync(vaultPath, { recursive: true, force: true });
    rmSync(localVault, { recursive: true, force: true });
  });

  test("passes when a core skill exists in vault_path even though local_vault_paths is also configured", () => {
    const vaultPath = tmpVault();
    const localVault = tmpVault();
    writeSkillAt(vaultPath, "core-skill");
    const manifest = parseManifest(`
[core]
skills = ["core-skill"]

[targets.claude]
dir = "~/.claude/skills"
`);
    const result = validateManifest(manifest, vaultPath, [localVault]);
    expect(result.notes).toEqual([]);

    rmSync(vaultPath, { recursive: true, force: true });
    rmSync(localVault, { recursive: true, force: true });
  });
});

describe("serializeManifest", () => {
  test("round-trips through parseManifest for core, project, and targets", () => {
    const manifest = parseManifest(`
[core]
skills = ["writing-clearly", "code-review"]

[project.infra]
repos = ["~/workspace/infra"]
skills = ["terraform-plans"]

[targets.claude]
dir = "~/.claude/skills"
project_groups = ["infra"]
`);

    const roundTripped = parseManifest(serializeManifest(manifest));

    expect(roundTripped).toEqual(manifest);
  });

  test("serializes an empty manifest (no project groups, no targets) parseably", () => {
    const manifest = parseManifest(`
[core]
skills = []

[targets.claude]
dir = "~/.claude/skills"
`);

    const roundTripped = parseManifest(serializeManifest(manifest));

    expect(roundTripped).toEqual(manifest);
  });
});

describe("resolveManifestPath (Shim 3)", () => {
  test("resolves skillmux.toml when it exists", () => {
    const tmp = mkdtempSync(join(tmpdir(), "skillmux-manifest-resolve-"));
    writeFileSync(join(tmp, "skillmux.toml"), "core = { skills = [] }");
    writeFileSync(join(tmp, "skr.toml"), "core = { skills = [] }");

    const path = resolveManifestPath(tmp);
    expect(path).toBe(join(tmp, "skillmux.toml"));

    rmSync(tmp, { recursive: true, force: true });
  });

  test("falls back to skr.toml when skillmux.toml does not exist", () => {
    const tmp = mkdtempSync(join(tmpdir(), "skillmux-manifest-resolve-"));
    writeFileSync(join(tmp, "skr.toml"), "core = { skills = [] }");

    const path = resolveManifestPath(tmp);
    expect(path).toBe(join(tmp, "skr.toml"));

    rmSync(tmp, { recursive: true, force: true });
  });

  test("returns null when neither exist", () => {
    const tmp = mkdtempSync(join(tmpdir(), "skillmux-manifest-resolve-"));

    const path = resolveManifestPath(tmp);
    expect(path).toBeNull();

    rmSync(tmp, { recursive: true, force: true });
  });
});
