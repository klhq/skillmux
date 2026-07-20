import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openIndex, toFtsQuery, upsertSkill, deleteSkill, skillCount, getSkillRow, replaceSkills } from "../src/db";
import type { Database } from "bun:sqlite";

describe("db utils", () => {
  test("toFtsQuery sanitizes input properly", () => {
    // Normal query with punctuation
    expect(toFtsQuery("hello, world!")).toBe('"hello" OR "world"');

    // Case folding and duplicate removal
    expect(toFtsQuery("Hello hello WORLD")).toBe('"hello" OR "world"');

    // Filters out terms shorter than 2 characters
    expect(toFtsQuery("a b cd e")).toBe('"cd"');

    // Empty text or only short terms
    expect(toFtsQuery("   ")).toBeNull();
    expect(toFtsQuery("a b")).toBeNull();

    // CJK characters
    expect(toFtsQuery("容器 部署")).toBe('"容器" OR "部署"');
  });

  describe("database CRUD operations", () => {
    let tmp: string;
    let db: Database;

    beforeAll(() => {
      tmp = mkdtempSync(join(tmpdir(), "skillmux-db-test-"));
      db = openIndex(tmp);
    });

    afterAll(() => {
      db.close();
      rmSync(tmp, { recursive: true, force: true });
    });

    test("upsertSkill, skillCount, getSkillRow, and deleteSkill work correctly", () => {
      expect(skillCount(db)).toBe(0);

      const skill = {
        skill_id: "test-skill",
        title: "Test Skill",
        description: "A test description.",
        aliases: ["alias-one", "alias-two"],
        body: "content",
        content_sha256: "hash123",
      };

      upsertSkill(db, skill);
      expect(skillCount(db)).toBe(1);

      const row = getSkillRow(db, "test-skill");
      expect(row).not.toBeNull();
      expect(row!.title).toBe("Test Skill");
      expect(row!.aliases).toBe("alias-one alias-two");
      expect(row!.content_sha256).toBe("hash123");

      deleteSkill(db, "test-skill");
      expect(skillCount(db)).toBe(0);
      expect(getSkillRow(db, "test-skill")).toBeNull();
    });

    test("replaceSkills replaces all current skills and cleans vectors", () => {
      const skills = [
        {
          skill_id: "skill-1",
          title: "Skill 1",
          description: "Desc 1",
          aliases: "alias1",
          content_sha256: "sha1",
        },
        {
          skill_id: "skill-2",
          title: "Skill 2",
          description: "Desc 2",
          aliases: "alias2",
          content_sha256: "sha2",
        },
      ];

      replaceSkills(db, skills);
      expect(skillCount(db)).toBe(2);

      // Now replace with empty list
      replaceSkills(db, []);
      expect(skillCount(db)).toBe(0);
    });
  });
});
