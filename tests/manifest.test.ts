import { describe, expect, test } from "bun:test";
import { parseManifest, validateManifest } from "../src/manifest";

describe("parseManifest", () => {
  test("parses a valid skr.toml into typed core/project/targets", () => {
    const toml = `
[core]
skills = ["writing-clearly", "code-review"]

[project.infra]
repos = ["~/workspace/infra"]
skills = ["terraform-plans"]

[targets.claude]
dir = "~/.claude/skills"
project = true
`;
    const manifest = parseManifest(toml);
    expect(manifest).toEqual({
      core: { skills: ["writing-clearly", "code-review"] },
      project: { infra: { repos: ["~/workspace/infra"], skills: ["terraform-plans"] } },
      targets: { claude: { dir: "~/.claude/skills", project: true } },
    });
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
    const manifest = parseManifest(`
[core]
skills = ["ghost-skill"]

[targets.claude]
dir = "~/.claude/skills"
`);
    expect(() => validateManifest(manifest, new Set(["writing-clearly"]))).toThrow("ghost-skill");
  });

  test("throws naming a skill listed in both [core] and a [project.*] group", () => {
    const manifest = parseManifest(`
[core]
skills = ["shared-skill"]

[project.infra]
repos = []
skills = ["shared-skill"]

[targets.claude]
dir = "~/.claude/skills"
`);
    expect(() => validateManifest(manifest, new Set(["shared-skill"]))).toThrow("shared-skill");
  });

  test("passes for a manifest whose skills all exist and don't overlap", () => {
    const manifest = parseManifest(`
[core]
skills = ["core-skill"]

[project.infra]
repos = []
skills = ["infra-skill"]

[targets.claude]
dir = "~/.claude/skills"
`);
    const result = validateManifest(manifest, new Set(["core-skill", "infra-skill"]));
    expect(result.notes).toEqual([]);
  });
});
