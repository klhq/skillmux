import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ftsSearch, openIndex, replaceSkills, upsertSkill, type SkillRow } from "../src/db";

function skill(overrides: Partial<SkillRow> = {}): SkillRow {
  return { skill_id: "alpha-helper", title: "Utility", description: "Instructions", aliases: "", content_sha256: "hash", ...overrides };
}

test("lexical search matches English word forms in both directions across metadata fields and updates", () => {
  const dir = mkdtempSync(join(tmpdir(), "skillmux-stemming-"));
  const db = openIndex(dir);
  try {
    for (const field of ["skill_id", "title", "description", "aliases"] as const) {
      for (const [base, variant] of [["debug", "debugging"], ["deploy", "deploying"], ["test", "tests"]]) {
        for (const [indexed, query] of [[base, variant], [variant, base]]) {
          const row = skill({ [field]: field === "skill_id" ? `${indexed}-helper` : indexed });
          replaceSkills(db, [row]);
          expect(ftsSearch(db, query!, 5).map((result) => result.skill_id)).toEqual([row.skill_id]);
        }
      }
    }
    upsertSkill(db, { ...skill({ description: "Plan maintenance" }), aliases: ["testing"], body: "Instructions" });
    expect(ftsSearch(db, "planning", 5).map((row) => row.skill_id)).toEqual(["alpha-helper"]);
    expect(ftsSearch(db, "test", 5).map((row) => row.skill_id)).toEqual(["alpha-helper"]);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
