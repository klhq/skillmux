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
      for (const [base, variant] of [["debug", "debugging"], ["deploy", "deploying"], ["test", "tests"]] as const) {
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

test("opening a version-2 index upgrades word-form recall while preserving skills, vectors and metadata", () => {
  const dir = mkdtempSync(join(tmpdir(), "skillmux-stemming-upgrade-"));
  let db: Database = openIndex(dir);
  try {
    replaceSkills(db, [skill({ description: "Debug utilities" })]);
    db.run("DROP TABLE skills_fts");
    db.run(`CREATE VIRTUAL TABLE skills_fts USING fts5(
      skill_id, title, description, aliases,
      tokenize = "unicode61 remove_diacritics 2 tokenchars '+#'"
    )`);
    db.run("INSERT INTO skills_fts SELECT skill_id, title, description, aliases FROM skills");
    db.run("UPDATE index_meta SET value = '2' WHERE key = 'lexical_schema_version'");
    db.run("INSERT INTO index_meta VALUES ('last_indexed_fingerprint', 'vault-unchanged')");
    db.run("INSERT INTO vectors VALUES (?, ?, ?, ?, ?)", ["alpha-helper", "hash", "model:2", 2, new Float32Array([0.25, 0.75])]);
    const skills = db.query("SELECT * FROM skills").all();
    const vectors = db.query("SELECT * FROM vectors").all();
    expect(ftsSearch(db, "debugging", 5)).toEqual([]);
    db.close();

    db = openIndex(dir);
    expect(ftsSearch(db, "debugging", 5).map((row) => row.skill_id)).toEqual(["alpha-helper"]);
    expect(db.query("SELECT * FROM skills").all()).toEqual(skills);
    expect(db.query("SELECT * FROM vectors").all()).toEqual(vectors);
    expect(db.query("SELECT value FROM index_meta WHERE key = 'last_indexed_fingerprint'").get()).toEqual({ value: "vault-unchanged" });
    db.close();
    db = openIndex(dir);
    expect(ftsSearch(db, "debugging", 5).map((row) => row.skill_id)).toEqual(["alpha-helper"]);
    expect(db.query("SELECT * FROM vectors").all()).toEqual(vectors);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
