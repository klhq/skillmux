import { describe, expect, test } from "bun:test";
import { parseManifest } from "../src/manifest";

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
