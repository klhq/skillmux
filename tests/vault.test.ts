import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SKILL_ID_PATTERN,
  parseSkillMd,
  decodeUtf8Strict,
  listSupportingFiles,
  vaultResolutionOrder,
  resolveSkillRoot,
  scanVaults,
  findShadowedSkills,
} from "../src/vault";

function writeSkillAt(root: string, skillId: string, description: string) {
  const dir = join(root, skillId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${skillId}\ndescription: ${description}\n---\n\nbody\n`);
}

describe("vault utils", () => {
  test("SKILL_ID_PATTERN matches valid ids and rejects invalid ones", () => {
    expect(SKILL_ID_PATTERN.test("valid-id")).toBe(true);
    expect(SKILL_ID_PATTERN.test("valid123-id")).toBe(true);
    expect(SKILL_ID_PATTERN.test("-invalid-id")).toBe(false);
    expect(SKILL_ID_PATTERN.test("invalid_id")).toBe(false);
    expect(SKILL_ID_PATTERN.test("a")).toBe(false); // too short
  });

  test("decodeUtf8Strict decodes valid strings and throws on invalid utf-8", () => {
    const validBytes = new TextEncoder().encode("hello world");
    expect(decodeUtf8Strict(validBytes)).toBe("hello world");

    // Invalid UTF-8 sequence
    const invalidBytes = new Uint8Array([0xff, 0xff, 0xff]);
    expect(() => decodeUtf8Strict(invalidBytes)).toThrow();
  });

  test("parseSkillMd parses frontmatter and defaults correctly", () => {
    const raw = `---
name: Custom Name
description: A nice description.
aliases:
  - alias-one
  - alias-two
---

# Title
Some content.`;
    const skill = parseSkillMd("my-skill", raw);
    expect(skill.skill_id).toBe("my-skill");
    expect(skill.title).toBe("Custom Name");
    expect(skill.description).toBe("A nice description.");
    expect(skill.aliases).toEqual(["alias-one", "alias-two"]);
    expect(skill.body).toBe(raw);
  });

  test("parseSkillMd uses skill_id as name if missing name or empty", () => {
    const raw = `---
description: No name here
---
# Content`;
    const skill = parseSkillMd("my-skill", raw);
    expect(skill.title).toBe("my-skill");
  });

  test("parseSkillMd throws on unterminated frontmatter", () => {
    const raw = `---
name: Broken
description: Unterminated
`;
    expect(() => parseSkillMd("broken-skill", raw)).toThrow("unterminated frontmatter");
  });

  test("listSupportingFiles ignores SKILL.md and returns sorted relative paths", () => {
    const tmp = mkdtempSync(join(tmpdir(), "skillmux-vault-test-"));
    const skillId = "test-skill";
    const skillDir = join(tmp, skillId);
    mkdirSync(skillDir, { recursive: true });

    writeFileSync(join(skillDir, "SKILL.md"), "main file");
    writeFileSync(join(skillDir, "doc.txt"), "text file");
    
    const subDir = join(skillDir, "scripts");
    mkdirSync(subDir);
    writeFileSync(join(subDir, "helper.py"), "script");

    const files = listSupportingFiles(tmp, skillId);
    expect(files).toEqual(["doc.txt", "scripts/helper.py"]);

    rmSync(tmp, { recursive: true, force: true });
  });
});

describe("vaultResolutionOrder", () => {
  test("puts local_vault_paths first in order, with vault_path as the fallback", () => {
    expect(vaultResolutionOrder("/vault", ["/local-a", "/local-b"])).toEqual([
      "/local-a",
      "/local-b",
      "/vault",
    ]);
  });

  test("is just vault_path when no local_vault_paths are configured", () => {
    expect(vaultResolutionOrder("/vault", [])).toEqual(["/vault"]);
  });
});

describe("resolveSkillRoot", () => {
  test("returns the first local_vault_paths entry that has the skill", () => {
    const vaultPath = mkdtempSync(join(tmpdir(), "skillmux-resolve-vault-"));
    const localA = mkdtempSync(join(tmpdir(), "skillmux-resolve-local-"));
    writeSkillAt(vaultPath, "shared-skill", "upstream");
    writeSkillAt(localA, "shared-skill", "local override");

    expect(resolveSkillRoot("shared-skill", vaultPath, [localA])).toBe(localA);

    rmSync(vaultPath, { recursive: true, force: true });
    rmSync(localA, { recursive: true, force: true });
  });

  test("falls back to vault_path when no local_vault_paths entry has the skill", () => {
    const vaultPath = mkdtempSync(join(tmpdir(), "skillmux-resolve-vault-"));
    const localA = mkdtempSync(join(tmpdir(), "skillmux-resolve-local-"));
    writeSkillAt(vaultPath, "upstream-only-skill", "upstream");

    expect(resolveSkillRoot("upstream-only-skill", vaultPath, [localA])).toBe(vaultPath);

    rmSync(vaultPath, { recursive: true, force: true });
    rmSync(localA, { recursive: true, force: true });
  });

  test("returns null when no configured root has the skill", () => {
    const vaultPath = mkdtempSync(join(tmpdir(), "skillmux-resolve-vault-"));

    expect(resolveSkillRoot("ghost-skill", vaultPath, [])).toBeNull();

    rmSync(vaultPath, { recursive: true, force: true });
  });
});

describe("scanVaults", () => {
  test("merges skills from every root, with local_vault_paths winning over vault_path on id collision", async () => {
    const vaultPath = mkdtempSync(join(tmpdir(), "skillmux-scanvaults-vault-"));
    const localA = mkdtempSync(join(tmpdir(), "skillmux-scanvaults-local-"));
    writeSkillAt(vaultPath, "shared-skill", "upstream");
    writeSkillAt(vaultPath, "upstream-only", "upstream");
    writeSkillAt(localA, "shared-skill", "local override");
    writeSkillAt(localA, "local-only", "local");

    const skills = await scanVaults(vaultPath, [localA]);
    const bySkillId = Object.fromEntries(skills.map((s) => [s.skill_id, s]));

    expect(bySkillId["shared-skill"]?.description).toBe("local override");
    expect(bySkillId["upstream-only"]?.description).toBe("upstream");
    expect(bySkillId["local-only"]?.description).toBe("local");
    expect(skills.length).toBe(3);

    rmSync(vaultPath, { recursive: true, force: true });
    rmSync(localA, { recursive: true, force: true });
  });
});

describe("findShadowedSkills", () => {
  test("reports a skill present in more than one root, winner first", () => {
    const vaultPath = mkdtempSync(join(tmpdir(), "skillmux-shadow-vault-"));
    const localA = mkdtempSync(join(tmpdir(), "skillmux-shadow-local-"));
    writeSkillAt(vaultPath, "shared-skill", "upstream");
    writeSkillAt(vaultPath, "upstream-only", "upstream");
    writeSkillAt(localA, "shared-skill", "local override");

    const shadowed = findShadowedSkills(vaultPath, [localA]);

    expect(shadowed).toEqual([{ skill_id: "shared-skill", winner: localA, shadowed: [vaultPath] }]);

    rmSync(vaultPath, { recursive: true, force: true });
    rmSync(localA, { recursive: true, force: true });
  });

  test("returns an empty array when no skill_id collides across roots", () => {
    const vaultPath = mkdtempSync(join(tmpdir(), "skillmux-shadow-vault-"));
    const localA = mkdtempSync(join(tmpdir(), "skillmux-shadow-local-"));
    writeSkillAt(vaultPath, "upstream-only", "upstream");
    writeSkillAt(localA, "local-only", "local");

    expect(findShadowedSkills(vaultPath, [localA])).toEqual([]);

    rmSync(vaultPath, { recursive: true, force: true });
    rmSync(localA, { recursive: true, force: true });
  });
});
