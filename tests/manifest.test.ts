import { describe, expect, test } from "bun:test";
import {
  parseManifest,
  pinCore,
  pinProject,
  LEGACY_TARGETS_ERROR,
  resolveManifestPath,
  resolveSyncSurfaces,
  serializeManifest,
  unpinCore,
  unpinProject,
  updateProjectAgents,
  updateProjectPaths,
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
  test("rejects a legacy [targets] table and says how to migrate", () => {
    const toml = `
[core]
skills = []

[targets.claude]
dir = "~/.claude/skills"
host = "workhorse"
project_groups = []
`;
    expect(() => parseManifest(toml)).toThrow(LEGACY_TARGETS_ERROR);
    expect(LEGACY_TARGETS_ERROR).toContain("agents");
    expect(LEGACY_TARGETS_ERROR).toContain("config.toml");
  });

  test("parses core and project groups, defaulting a project's agents to none", () => {
    const toml = `
[core]
skills = ["writing-clearly", "code-review"]

[project.infra]
paths = ["~/workspace/infra"]
skills = ["terraform-plans"]
agents = ["claude-code", "codex"]

[project.docs]
paths = ["~/workspace/docs"]
skills = []
`;
    expect(parseManifest(toml)).toEqual({
      core: { skills: ["writing-clearly", "code-review"] },
      project: {
        infra: { paths: ["~/workspace/infra"], skills: ["terraform-plans"], agents: ["claude-code", "codex"] },
        docs: { paths: ["~/workspace/docs"], skills: [], agents: [] },
      },
    });
  });

  test("rejects a project agent the registry does not know", () => {
    expect(() => parseManifest(`
[core]
skills = []

[project.infra]
paths = []
skills = []
agents = ["pi"]
`)).toThrow();
  });

  test("rejects the renamed [project.*].repos field", () => {
    const toml = `
[core]
skills = []

[project.infra]
repos = ["~/workspace/infra"]
skills = []

`;
    expect(() => parseManifest(toml)).toThrow(/paths/);
  });

  test("rejects a manifest missing the required [core] section", () => {
    const toml = `
`;
    expect(() => parseManifest(toml)).toThrow();
  });

  test("rejects a core skill id that violates the skill id pattern", () => {
    const toml = `
[core]
skills = ["Invalid_ID"]

`;
    expect(() => parseManifest(toml)).toThrow();
  });

  test("parses a core-only manifest", () => {
    expect(parseManifest(`
[core]
skills = []
`)).toEqual({
      core: { skills: [] },
    });
  });

  test("fails schema validation when limit is non-positive or non-integer", () => {
    expect(() =>
      parseManifest(`
[core]
limit = 0
skills = []
`),
    ).toThrow();

    expect(() =>
      parseManifest(`
[core]
limit = -1
skills = []
`),
    ).toThrow();

    expect(() =>
      parseManifest(`
[core]
limit = 2.5
skills = []
`),
    ).toThrow();

    expect(() =>
      parseManifest(`
[core]
limit = "30"
skills = []
`),
    ).toThrow();
  });
});

describe("serializeManifest", () => {
  test("writes each project's agents", () => {
    const manifest = parseManifest(`
[core]
skills = []

[project.infra]
paths = ["/work/infra"]
skills = []
agents = ["claude-code"]
`);

    expect(serializeManifest(manifest)).toContain('agents = ["claude-code"]');
  });

  test("writes a configured core limit back out so a pin does not erase it", () => {
    const manifest = parseManifest(`
[core]
skills = []
limit = 30
`);

    expect(serializeManifest(manifest)).toContain("limit = 30");
    expect(parseManifest(serializeManifest(manifest)).core.limit).toBe(30);
  });

  test("omits the limit entirely when the manifest never set one", () => {
    const manifest = parseManifest(`
[core]
skills = []
`);

    expect(serializeManifest(manifest)).not.toContain("limit");
    expect(parseManifest(serializeManifest(manifest)).core.limit).toBeUndefined();
  });
});

describe("resolveSyncSurfaces", () => {
  const manifest = parseManifest(`
[core]
skills = []

[project.web]
paths = ["/work/web"]
skills = []
agents = ["claude-code"]

[project.tools]
paths = ["/work/tools"]
skills = []
agents = ["opencode"]

[project.none]
paths = ["/work/none"]
skills = []
`);

  test("syncs one directory per distinct surface of this machine's agents", () => {
    const surfaces = resolveSyncSurfaces(manifest, ["claude-code", "windsurf", "hermes"], {
      home: "/home/test",
    });
    expect(surfaces.map(({ id, dir, agents }) => ({ id, dir, agents }))).toEqual([
      { id: "claude-code", dir: "/home/test/.claude/skills", agents: ["claude-code"] },
      { id: "agent-skills", dir: "/home/test/.agents/skills", agents: ["windsurf", "hermes"] },
    ]);
  });

  test("a project reaches a directory any of its agents reads, matched by directory", () => {
    const surfaces = resolveSyncSurfaces(manifest, ["claude-code", "hermes"], { home: "/home/test" });
    const groups = Object.fromEntries(
      surfaces.map((surface) => [surface.id, Object.keys(surface.projectGroups)]),
    );
    // tools names opencode, which this machine does not use — but hermes reads
    // the same ~/.agents/skills, so the project's skills still land there.
    expect(groups).toEqual({ "claude-code": ["web"], "agent-skills": ["tools"] });
  });

  test("a project with no agents syncs nowhere", () => {
    const surfaces = resolveSyncSurfaces(manifest, ["claude-code", "opencode"], { home: "/home/test" });
    for (const surface of surfaces) expect(surface.projectGroups).not.toHaveProperty("none");
  });

  test("a machine with no agents syncs nothing", () => {
    expect(resolveSyncSurfaces(manifest, [], { home: "/home/test" })).toEqual([]);
  });
});

describe("pinCore", () => {
  test("appends a skill_id to [core].skills", () => {
    const manifest = parseManifest(`
[core]
skills = ["writing-clearly"]

`);

    const updated = pinCore(manifest, "code-review");

    expect(updated.core.skills).toEqual(["writing-clearly", "code-review"]);
  });

  test("throws when the skill_id is already pinned in [core]", () => {
    const manifest = parseManifest(`
[core]
skills = ["writing-clearly"]

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

`);

    expect(() => pinCore(manifest, "terraform-plans")).toThrow(/already pinned/);
  });
});

describe("unpinCore", () => {
  test("removes a skill_id from [core].skills", () => {
    const manifest = parseManifest(`
[core]
skills = ["writing-clearly", "code-review"]

`);

    const updated = unpinCore(manifest, "writing-clearly");

    expect(updated.core.skills).toEqual(["code-review"]);
  });

  test("throws when the skill_id is not pinned in [core]", () => {
    const manifest = parseManifest(`
[core]
skills = []

`);

    expect(() => unpinCore(manifest, "ghost-skill")).toThrow(/not pinned in \[core\]/);
  });

  test("limit survives a pin and an unpin round trip", () => {
    const manifest = parseManifest(`
[core]
limit = 30
skills = ["writing-clearly"]

`);

    const pinned = pinCore(manifest, "code-review");
    expect(pinned.core.limit).toBe(30);
    expect(pinned.core.skills).toEqual(["writing-clearly", "code-review"]);

    const unpinned = unpinCore(pinned, "code-review");
    expect(unpinned.core.limit).toBe(30);
    expect(unpinned.core.skills).toEqual(["writing-clearly"]);
  });
});

describe("pinProject", () => {
  test("creates a new [project.*] group with the given paths and skill_id", () => {
    const manifest = parseManifest(`
[core]
skills = []

`);

    const updated = pinProject(manifest, "terraform-plans", "infra", ["~/workspace/infra"]);

    expect(updated.project?.infra).toEqual({ paths: ["~/workspace/infra"], skills: ["terraform-plans"], agents: [] });
  });

  test("throws when the group does not exist and no --path was given", () => {
    const manifest = parseManifest(`
[core]
skills = []

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

`);

    expect(() => pinProject(manifest, "another-skill", "infra", ["~/workspace/other"])).toThrow(
      /group "infra" already exists/,
    );
  });

  test("throws when the skill_id is already pinned elsewhere", () => {
    const manifest = parseManifest(`
[core]
skills = ["writing-clearly"]

`);

    expect(() => pinProject(manifest, "writing-clearly", "infra", ["~/workspace/infra"])).toThrow(
      /already pinned/,
    );
  });

  test("throws instead of writing an invalid group name that would corrupt the TOML on next parse", () => {
    const manifest = parseManifest(`
[core]
skills = []

`);

    expect(() => pinProject(manifest, "some-skill", "Bad Group!", ["~/workspace/x"])).toThrow(
      /invalid group name/,
    );
  });
});

describe("upsertProject", () => {
  test("merges paths, skills, and agents without duplicates", () => {
    const manifest = parseManifest(`
[core]
skills = []

[project.infra]
paths = ["/work/infra"]
skills = ["terraform-plans"]
agents = ["codex"]
`);

    const updated = upsertProject(manifest, {
      name: "infra",
      paths: ["/work/infra", "/Users/me/infra"],
      skills: ["terraform-plans", "incident-response"],
      agents: ["codex", "claude-code"],
    });

    expect(updated.project?.infra).toEqual({
      paths: ["/work/infra", "/Users/me/infra"],
      skills: ["terraform-plans", "incident-response"],
      agents: ["codex", "claude-code"],
    });
  });

  test("rejects an invalid project skill ID before manifest validation", () => {
    const manifest = parseManifest(`
[core]
skills = []

`);

    expect(() => upsertProject(manifest, {
      name: "demo",
      paths: ["/work/demo"],
      skills: ["../../outside"],
      agents: [],
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
      agents: [],
    });
  });
});

test("updateProjectAgents attaches and detaches agents idempotently", () => {
  const manifest = parseManifest(`
[core]
skills = []

[project.demo]
paths = ["/work/demo"]
skills = []
agents = ["codex"]
`);

  const updated = updateProjectAgents(manifest, "demo", {
    attach: ["claude-code", "claude-code"],
    detach: ["codex"],
  });

  expect(updated.project?.demo?.agents).toEqual(["claude-code"]);
  expect(() => updateProjectAgents(manifest, "missing", { attach: ["codex"] })).toThrow(
    "[project.missing] does not exist",
  );
});

describe("unpinProject", () => {
  test("removes a skill_id from an existing group, leaving the group in place", () => {
    const manifest = parseManifest(`
[core]
skills = []

[project.infra]
paths = ["~/workspace/infra"]
skills = ["terraform-plans"]

`);

    const updated = unpinProject(manifest, "terraform-plans", "infra");

    expect(updated.project?.infra).toEqual({ paths: ["~/workspace/infra"], skills: [], agents: [] });
  });

  test("throws when the group does not exist", () => {
    const manifest = parseManifest(`
[core]
skills = []

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

`);
    const result = validateManifest(manifest, vaultPath);
    expect(result.notes).toEqual([]);

    rmSync(vaultPath, { recursive: true, force: true });
  });

  test("throws naming the count when [core] exceeds 25 skills (no limit specified)", () => {
    const vaultPath = tmpVault();
    const skillIds = Array.from({ length: 26 }, (_, i) => `skill-${i}`);
    for (const skillId of skillIds) writeSkillAt(vaultPath, skillId);
    const manifest = parseManifest(`
[core]
skills = ${JSON.stringify(skillIds)}

`);
    expect(() => validateManifest(manifest, vaultPath)).toThrow(
      "[core] has 26 skills, exceeding the limit of 25",
    );

    rmSync(vaultPath, { recursive: true, force: true });
  });

  test("a manifest with limit = 30 accepts 29 core skills", () => {
    const vaultPath = tmpVault();
    const skillIds = Array.from({ length: 29 }, (_, i) => `skill-${i}`);
    for (const skillId of skillIds) writeSkillAt(vaultPath, skillId);
    const manifest = parseManifest(`
[core]
limit = 30
skills = ${JSON.stringify(skillIds)}

`);
    expect(() => validateManifest(manifest, vaultPath)).not.toThrow();

    rmSync(vaultPath, { recursive: true, force: true });
  });

  test("a manifest with limit = 30 still rejects 31 core skills", () => {
    const vaultPath = tmpVault();
    const skillIds = Array.from({ length: 31 }, (_, i) => `skill-${i}`);
    for (const skillId of skillIds) writeSkillAt(vaultPath, skillId);
    const manifest = parseManifest(`
[core]
limit = 30
skills = ${JSON.stringify(skillIds)}

`);
    expect(() => validateManifest(manifest, vaultPath)).toThrow(
      "[core] has 31 skills, exceeding the limit of 30",
    );

    rmSync(vaultPath, { recursive: true, force: true });
  });

  test("points at the [core] limit key so whoever hits the default knows it can move", () => {
    const vaultPath = tmpVault();
    const skillIds = Array.from({ length: 26 }, (_, i) => `skill-${i}`);
    for (const skillId of skillIds) writeSkillAt(vaultPath, skillId);
    const manifest = parseManifest(`
[core]
skills = ${JSON.stringify(skillIds)}

`);
    expect(() => validateManifest(manifest, vaultPath)).toThrow(
      'unpin a skill, or set "limit" under [core] to raise the default',
    );

    rmSync(vaultPath, { recursive: true, force: true });
  });

  test("tells someone who already set a limit to raise that key rather than to set it", () => {
    const vaultPath = tmpVault();
    const skillIds = Array.from({ length: 31 }, (_, i) => `skill-${i}`);
    for (const skillId of skillIds) writeSkillAt(vaultPath, skillId);
    const manifest = parseManifest(`
[core]
limit = 30
skills = ${JSON.stringify(skillIds)}

`);
    expect(() => validateManifest(manifest, vaultPath)).toThrow(
      'unpin a skill, or raise "limit" under [core]',
    );

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

`);
    const result = validateManifest(manifest, vaultPath, [localVault]);
    expect(result.notes).toEqual([]);

    rmSync(vaultPath, { recursive: true, force: true });
    rmSync(localVault, { recursive: true, force: true });
  });
});

describe("serializeManifest", () => {
  test("round-trips through parseManifest for core and project", () => {
    const manifest = parseManifest(`
[core]
skills = ["writing-clearly", "code-review"]

[project.infra]
paths = ["~/workspace/infra"]
skills = ["terraform-plans"]
agents = ["claude-code", "codex"]
`);

    const roundTripped = parseManifest(serializeManifest(manifest));

    expect(roundTripped).toEqual(manifest);
  });

  test("serializes an empty manifest (no project groups) parseably", () => {
    const manifest = parseManifest(`
[core]
skills = []

`);

    const roundTripped = parseManifest(serializeManifest(manifest));

    expect(roundTripped).toEqual(manifest);
  });
});

test("writeManifestAtomic replaces a manifest with parseable content", () => {
  const root = tmpVault();
  const path = join(root, "skillmux.toml");
  const manifest = parseManifest(`
[core]
skills = []

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
