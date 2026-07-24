import { describe, expect, test } from "bun:test";
import {
  parseManifest,
  pinCore,
  pinProject,
  resolveManifestPath,
  serializeManifest,
  unpinCore,
  unpinProject,
  updateProjectPaths,
  updateProjectTargets,
  upsertProject,
  validateManifest,
  writeManifestAtomic,
} from "../src/manifest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
paths = ["~/workspace/infra"]
skills = ["terraform-plans"]

[targets.claude]
dir = "~/.claude/skills"
host = "workhorse"
project_groups = ["infra"]
`;
    const manifest = parseManifest(toml);
    expect(manifest).toEqual({
      core: { skills: ["writing-clearly", "code-review"] },
      project: { infra: { paths: ["~/workspace/infra"], skills: ["terraform-plans"] } },
      targets: {
        claude: { dir: "~/.claude/skills", host: "workhorse", project_groups: ["infra"] },
      },
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

  test("rejects the renamed [project.*].repos field", () => {
    const toml = `
[core]
skills = []

[project.infra]
repos = ["~/workspace/infra"]
skills = []

[targets.claude]
dir = "~/.claude/skills"
`;
    expect(() => parseManifest(toml)).toThrow(/paths/);
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

  test("parses a core-only manifest with no configured targets", () => {
    expect(parseManifest(`
[core]
skills = []
`)).toEqual({
      core: { skills: [] },
      targets: {},
    });
  });
});

describe("pinCore", () => {
  test("appends a skill_id to [core].skills", () => {
    const manifest = parseManifest(`
[core]
skills = ["writing-clearly"]

[targets.claude]
dir = "~/.claude/skills"
`);

    const updated = pinCore(manifest, "code-review");

    expect(updated.core.skills).toEqual(["writing-clearly", "code-review"]);
  });

  test("throws when the skill_id is already pinned in [core]", () => {
    const manifest = parseManifest(`
[core]
skills = ["writing-clearly"]

[targets.claude]
dir = "~/.claude/skills"
`);

    expect(() => pinCore(manifest, "writing-clearly")).toThrow(/already pinned in \[core\]/);
  });

  test("throws when the skill_id is already pinned in a [project.*] group", () => {
    const manifest = parseManifest(`
[core]
skills = []

[project.infra]
paths = ["~/workspace/infra"]
skills = ["terraform-plans"]

[targets.claude]
dir = "~/.claude/skills"
`);

    expect(() => pinCore(manifest, "terraform-plans")).toThrow(/already pinned/);
  });
});

describe("unpinCore", () => {
  test("removes a skill_id from [core].skills", () => {
    const manifest = parseManifest(`
[core]
skills = ["writing-clearly", "code-review"]

[targets.claude]
dir = "~/.claude/skills"
`);

    const updated = unpinCore(manifest, "writing-clearly");

    expect(updated.core.skills).toEqual(["code-review"]);
  });

  test("throws when the skill_id is not pinned in [core]", () => {
    const manifest = parseManifest(`
[core]
skills = []

[targets.claude]
dir = "~/.claude/skills"
`);

    expect(() => unpinCore(manifest, "ghost-skill")).toThrow(/not pinned in \[core\]/);
  });
});

describe("pinProject", () => {
  test("creates a new [project.*] group with the given paths and skill_id", () => {
    const manifest = parseManifest(`
[core]
skills = []

[targets.claude]
dir = "~/.claude/skills"
`);

    const updated = pinProject(manifest, "terraform-plans", "infra", ["~/workspace/infra"]);

    expect(updated.project?.infra).toEqual({ paths: ["~/workspace/infra"], skills: ["terraform-plans"] });
  });

  test("throws when the group does not exist and no --path was given", () => {
    const manifest = parseManifest(`
[core]
skills = []

[targets.claude]
dir = "~/.claude/skills"
`);

    expect(() => pinProject(manifest, "terraform-plans", "infra")).toThrow(
      /group "infra" does not exist.*--path/,
    );
  });

  test("appends a skill_id to an existing group", () => {
    const manifest = parseManifest(`
[core]
skills = []

[project.infra]
paths = ["~/workspace/infra"]
skills = ["terraform-plans"]

[targets.claude]
dir = "~/.claude/skills"
`);

    const updated = pinProject(manifest, "another-skill", "infra");

    expect(updated.project?.infra?.skills).toEqual(["terraform-plans", "another-skill"]);
  });

  test("throws when --path is passed for an already-existing group", () => {
    const manifest = parseManifest(`
[core]
skills = []

[project.infra]
paths = ["~/workspace/infra"]
skills = ["terraform-plans"]

[targets.claude]
dir = "~/.claude/skills"
`);

    expect(() => pinProject(manifest, "another-skill", "infra", ["~/workspace/other"])).toThrow(
      /group "infra" already exists/,
    );
  });

  test("throws when the skill_id is already pinned elsewhere", () => {
    const manifest = parseManifest(`
[core]
skills = ["writing-clearly"]

[targets.claude]
dir = "~/.claude/skills"
`);

    expect(() => pinProject(manifest, "writing-clearly", "infra", ["~/workspace/infra"])).toThrow(
      /already pinned/,
    );
  });

  test("throws instead of writing an invalid group name that would corrupt the TOML on next parse", () => {
    const manifest = parseManifest(`
[core]
skills = []

[targets.claude]
dir = "~/.claude/skills"
`);

    expect(() => pinProject(manifest, "some-skill", "Bad Group!", ["~/workspace/x"])).toThrow(
      /invalid group name/,
    );
  });
});

describe("upsertProject", () => {
  test("merges paths, skills, and target attachments without duplicates", () => {
    const manifest = parseManifest(`
[core]
skills = []

[project.infra]
paths = ["/work/infra"]
skills = ["terraform-plans"]

[targets.claude]
dir = "~/.claude/skills"
project_groups = []
`);

    const updated = upsertProject(manifest, {
      name: "infra",
      paths: ["/work/infra", "/Users/me/infra"],
      skills: ["terraform-plans", "incident-response"],
      targets: ["claude"],
    });

    expect(updated.project?.infra).toEqual({
      paths: ["/work/infra", "/Users/me/infra"],
      skills: ["terraform-plans", "incident-response"],
    });
    expect(updated.targets.claude?.project_groups).toEqual(["infra"]);
  });

  test("rejects an invalid project skill ID before manifest validation", () => {
    const manifest = parseManifest(`
[core]
skills = []

[targets.test]
dir = "~/.agents/skills"
`);

    expect(() => upsertProject(manifest, {
      name: "demo",
      paths: ["/work/demo"],
      skills: ["../../outside"],
      targets: [],
    })).toThrow(/invalid skill ID/);
  });
});

describe("updateProjectPaths", () => {
  test("adds and removes paths idempotently while preserving project skills", () => {
    const manifest = parseManifest(`
[core]
skills = []

[project.demo]
paths = ["/work/one"]
skills = ["first-skill"]

[targets.test]
dir = "~/.agents/skills"
`);

    const added = updateProjectPaths(manifest, "demo", {
      add: ["/work/one", "/work/two"],
    });
    const removed = updateProjectPaths(added, "demo", {
      remove: ["/work/one", "/missing"],
    });

    expect(removed.project?.demo).toEqual({
      paths: ["/work/two"],
      skills: ["first-skill"],
    });
  });
});

test("updateProjectTargets attaches and detaches a group idempotently", () => {
  const manifest = parseManifest(`
[core]
skills = []

[project.demo]
paths = ["/work/demo"]
skills = []

[targets.one]
dir = "~/.one/skills"
project_groups = []

[targets.two]
dir = "~/.two/skills"
project_groups = ["demo"]
`);

  const updated = updateProjectTargets(manifest, "demo", {
    attach: ["one", "one"],
    detach: ["two"],
  });

  expect(updated.targets.one?.project_groups).toEqual(["demo"]);
  expect(updated.targets.two?.project_groups).toEqual([]);
});

describe("unpinProject", () => {
  test("removes a skill_id from an existing group, leaving the group in place", () => {
    const manifest = parseManifest(`
[core]
skills = []

[project.infra]
paths = ["~/workspace/infra"]
skills = ["terraform-plans"]

[targets.claude]
dir = "~/.claude/skills"
`);

    const updated = unpinProject(manifest, "terraform-plans", "infra");

    expect(updated.project?.infra).toEqual({ paths: ["~/workspace/infra"], skills: [] });
  });

  test("throws when the group does not exist", () => {
    const manifest = parseManifest(`
[core]
skills = []

[targets.claude]
dir = "~/.claude/skills"
`);

    expect(() => unpinProject(manifest, "terraform-plans", "infra")).toThrow(/\[project\.infra\] does not exist/);
  });

  test("throws when the skill_id is not pinned in the group", () => {
    const manifest = parseManifest(`
[core]
skills = []

[project.infra]
paths = ["~/workspace/infra"]
skills = ["terraform-plans"]

[targets.claude]
dir = "~/.claude/skills"
`);

    expect(() => unpinProject(manifest, "ghost-skill", "infra")).toThrow(/not pinned in \[project\.infra\]/);
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
paths = []
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
paths = []
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
paths = []
skills = []

[targets.claude]
dir = "~/.claude/skills"
project_groups = ["nonexistent"]
`);
    expect(() => validateManifest(manifest, vaultPath)).toThrow("nonexistent");

    rmSync(vaultPath, { recursive: true, force: true });
  });

  test("skips a [project.*].paths entry that doesn't exist locally with a note, not an error", () => {
    const vaultPath = tmpVault();
    const manifest = parseManifest(`
[core]
skills = []

[project.infra]
paths = ["/does/not/exist/on/this/machine"]
skills = []

[targets.claude]
dir = "~/.claude/skills"
`);
    const result = validateManifest(manifest, vaultPath);
    expect(result.notes).toEqual(["[project.infra] paths entry not found locally, skipped: /does/not/exist/on/this/machine"]);

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
paths = []
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
paths = ["~/workspace/infra"]
skills = ["terraform-plans"]

[targets.claude]
dir = "~/.claude/skills"
host = "workhorse"
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

  test("re-serializes a bare-string host as a bare string, not a single-element array", () => {
    const manifest = parseManifest(`
[core]
skills = []

[targets.claude]
dir = "~/.claude/skills"
host = "workhorse"
project_groups = []
`);

    const serialized = serializeManifest(manifest);

    expect(serialized).toContain(`host = "workhorse"`);
    expect(serialized).not.toContain(`host = ["workhorse"]`);
    expect(parseManifest(serialized)).toEqual(manifest);
  });

  test("re-serializes a multi-host array as the same array form", () => {
    const manifest = parseManifest(`
[core]
skills = []

[targets.claude]
dir = "~/.claude/skills"
host = ["workhorse", "piedpiper"]
project_groups = []
`);

    const serialized = serializeManifest(manifest);

    expect(serialized).toContain(`host = ["workhorse", "piedpiper"]`);
    const roundTripped = parseManifest(serialized);
    expect(roundTripped).toEqual(manifest);
    expect(roundTripped.targets.claude!.host).toEqual(["workhorse", "piedpiper"]);
  });
});

test("writeManifestAtomic replaces a manifest with parseable content", () => {
  const root = tmpVault();
  const path = join(root, "skillmux.toml");
  const manifest = parseManifest(`
[core]
skills = []

[targets.test]
dir = "~/.agents/skills"
`);

  writeManifestAtomic(path, manifest);

  expect(parseManifest(readFileSync(path, "utf8"))).toEqual(manifest);
  rmSync(root, { recursive: true, force: true });
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
