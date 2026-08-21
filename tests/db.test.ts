import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteSkill, getSkillRow, insertAudit, openIndex, replaceSkills, skillCount, toFtsQuery, upsertSkill } from "../src/db";
import { Database } from "bun:sqlite";

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

  describe("audit table schema and legacy migration", () => {
    test("openIndex safely migrates legacy audit schema with outcome NOT NULL CHECK and selected_skill_id", () => {
      const stateDir = mkdtempSync(join(tmpdir(), "skillmux-db-migration-"));
      const dbPath = join(stateDir, "index.sqlite3");

      // 1. Create a database directly with the exact legacy audit schema
      const legacyDb = new Database(dbPath, { create: true });
      legacyDb.run(`CREATE TABLE audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        query TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK (outcome IN ('matched', 'ambiguous', 'no_match')),
        degraded INTEGER NOT NULL,
        retrieval TEXT NOT NULL DEFAULT 'lexical',
        degraded_from TEXT,
        degradation_reason TEXT,
        candidates TEXT NOT NULL,
        selected_skill_id TEXT,
        latency_ms INTEGER NOT NULL
      )`);

      // 2. Insert representative legacy rows: matched, ambiguous, and no_match
      legacyDb.run(
        `INSERT INTO audit (ts, query, outcome, degraded, retrieval, degraded_from, degradation_reason, candidates, selected_skill_id, latency_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          "2026-07-01T10:00:00.000Z",
          "matched query",
          "matched",
          0,
          "reranked",
          null,
          null,
          JSON.stringify([{ skill_id: "matched-skill", score: 0.95 }]),
          "matched-skill",
          15,
        ],
      );
      legacyDb.run(
        `INSERT INTO audit (ts, query, outcome, degraded, retrieval, degraded_from, degradation_reason, candidates, selected_skill_id, latency_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          "2026-07-01T11:00:00.000Z",
          "ambiguous query",
          "ambiguous",
          1,
          "hybrid",
          "reranked",
          "reranker_timeout",
          JSON.stringify([
            { skill_id: "alpha-skill", score: 0.7 },
            { skill_id: "beta-skill", score: 0.6 },
          ]),
          null,
          25,
        ],
      );
      legacyDb.run(
        `INSERT INTO audit (ts, query, outcome, degraded, retrieval, degraded_from, degradation_reason, candidates, selected_skill_id, latency_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          "2026-07-01T12:00:00.000Z",
          "no match query",
          "no_match",
          0,
          "lexical",
          null,
          null,
          JSON.stringify([]),
          null,
          5,
        ],
      );
      legacyDb.close();

      // 3. Open index with openIndex, which runs the migration
      const migratedDb = openIndex(stateDir);

      // Verify columns in canonical table (no outcome, no selected_skill_id, no degraded)
      const columns = migratedDb.query("PRAGMA table_info(audit)").all() as { name: string }[];
      const columnNames = columns.map((c) => c.name);
      expect(columnNames).toContain("id");
      expect(columnNames).toContain("ts");
      expect(columnNames).toContain("query");
      expect(columnNames).toContain("retrieval");
      expect(columnNames).toContain("degraded_from");
      expect(columnNames).toContain("degradation_reason");
      expect(columnNames).toContain("candidates");
      expect(columnNames).toContain("latency_ms");

      expect(columnNames).not.toContain("outcome");
      expect(columnNames).not.toContain("selected_skill_id");
      expect(columnNames).not.toContain("degraded");

      // Verify preserved data
      const rows = migratedDb.query("SELECT * FROM audit ORDER BY id ASC").all() as any[];
      expect(rows).toHaveLength(3);

      expect(rows[0]).toEqual({
        id: 1,
        ts: "2026-07-01T10:00:00.000Z",
        query: "matched query",
        retrieval: "reranked",
        degraded_from: null,
        degradation_reason: null,
        candidates: JSON.stringify([{ skill_id: "matched-skill", score: 0.95 }]),
        latency_ms: 15,
      });

      expect(rows[1]).toEqual({
        id: 2,
        ts: "2026-07-01T11:00:00.000Z",
        query: "ambiguous query",
        retrieval: "hybrid",
        degraded_from: "reranked",
        degradation_reason: "reranker_timeout",
        candidates: JSON.stringify([
          { skill_id: "alpha-skill", score: 0.7 },
          { skill_id: "beta-skill", score: 0.6 },
        ]),
        latency_ms: 25,
      });

      expect(rows[2]).toEqual({
        id: 3,
        ts: "2026-07-01T12:00:00.000Z",
        query: "no match query",
        retrieval: "lexical",
        degraded_from: null,
        degradation_reason: null,
        candidates: JSON.stringify([]),
        latency_ms: 5,
      });

      migratedDb.close();

      // 4. Verify idempotent reopen
      const reopenedDb = openIndex(stateDir);
      const reopenedColumns = (reopenedDb.query("PRAGMA table_info(audit)").all() as { name: string }[]).map(
        (c) => c.name,
      );
      expect(reopenedColumns).not.toContain("outcome");
      expect(reopenedColumns).not.toContain("selected_skill_id");

      const reopenedRows = reopenedDb.query("SELECT * FROM audit ORDER BY id ASC").all();
      expect(reopenedRows).toHaveLength(3);

      // 5. Verify continued inserts with insertAudit
      insertAudit(reopenedDb, {
        ts: "2026-07-01T13:00:00.000Z",
        query: "new insert after migration",
        retrieval: "exact",
        candidates: [{ skill_id: "new-skill", score: 1.0 }],
        latency_ms: 2,
      });

      const finalRows = reopenedDb.query("SELECT * FROM audit ORDER BY id ASC").all() as any[];
      expect(finalRows).toHaveLength(4);
      expect(finalRows[3]).toEqual({
        id: 4,
        ts: "2026-07-01T13:00:00.000Z",
        query: "new insert after migration",
        retrieval: "exact",
        degraded_from: null,
        degradation_reason: null,
        candidates: JSON.stringify([{ skill_id: "new-skill", score: 1.0 }]),
        latency_ms: 2,
      });

      reopenedDb.close();
      rmSync(stateDir, { recursive: true, force: true });
    });
  });
});
