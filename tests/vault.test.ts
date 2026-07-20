import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SKILL_ID_PATTERN, parseSkillMd, decodeUtf8Strict, listSupportingFiles } from "../src/vault";

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
