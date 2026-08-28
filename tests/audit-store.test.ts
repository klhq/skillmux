import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { getAuditRowByRequestId, insertAudit, insertFetch, openAudit, openIndex, pruneAudit } from "../src/db";
import { queryAuditRows } from "../src/stats";

// The pre-split shape: a canonical audit table inside index.sqlite3. openIndex
// no longer produces this, so tests that exercise adoption build it directly.
function seedPreSplitAudit(stateDir: string, query: string): void {
  const index = new Database(join(stateDir, "index.sqlite3"), { create: true });
  index.run(`CREATE TABLE IF NOT EXISTS audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    query TEXT NOT NULL,
    retrieval TEXT NOT NULL DEFAULT 'lexical',
    degraded_from TEXT,
    degradation_reason TEXT,
    candidates TEXT NOT NULL,
    latency_ms INTEGER NOT NULL
  )`);
  index.run(
    "INSERT INTO audit (ts, query, retrieval, candidates, latency_ms) VALUES (?, ?, ?, ?, ?)",
    ["2026-08-27T00:00:00.000Z", query, "lexical", "[]", 7],
  );
  index.close();
}

describe("audit store", () => {
  let tmp: string;
  let db: Database | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "skillmux-audit-store-test-"));
  });

  afterEach(() => {
    db?.close();
    db = undefined;
    rmSync(tmp, { recursive: true, force: true });
  });

  test("should create audit.sqlite3 in state_dir with WAL journaling and incremental auto-vacuum", () => {
    db = openAudit(tmp);

    expect(existsSync(join(tmp, "audit.sqlite3"))).toBe(true);

    const journalMode = db.query("PRAGMA journal_mode").get() as { journal_mode: string };
    expect(journalMode.journal_mode).toBe("wal");

    // 2 is INCREMENTAL. It can only be set on an empty database, so this
    // asserts the pragma ran before any table was created.
    const autoVacuum = db.query("PRAGMA auto_vacuum").get() as { auto_vacuum: number };
    expect(autoVacuum.auto_vacuum).toBe(2);
  });

  test("should leave the index database free of any audit table", () => {
    const index = openIndex(tmp);
    const auditTables = index
      .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'audit'")
      .all();
    index.close();

    expect(auditTables).toHaveLength(0);
  });

  test("should round-trip a resolve audit row through the audit store", () => {
    db = openAudit(tmp);

    insertAudit(db, {
      ts: "2026-08-28T00:00:00.000Z",
      query: "convert a spreadsheet to markdown",
      retrieval: "hybrid",
      candidates: [{ skill_id: "csv-formatter", score: 0.92 }],
      latency_ms: 42,
    });

    const rows = queryAuditRows(db, "2026-08-01T00:00:00.000Z");

    expect(rows).toHaveLength(1);
    expect(rows[0]!.query).toBe("convert a spreadsheet to markdown");
    expect(rows[0]!.retrieval).toBe("hybrid");
    expect(rows[0]!.candidates).toEqual([{ skill_id: "csv-formatter", score: 0.92 }]);
    expect(rows[0]!.latency_ms).toBe(42);
  });

  test("should move pre-existing audit rows out of index.sqlite3 on first open", () => {
    seedPreSplitAudit(tmp, "written before the split");

    db = openAudit(tmp);

    const rows = queryAuditRows(db, "2026-08-01T00:00:00.000Z");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.query).toBe("written before the split");

    const index = new Database(join(tmp, "index.sqlite3"));
    const remaining = index
      .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'audit'")
      .all();
    index.close();
    expect(remaining).toHaveLength(0);
  });

  test("should not duplicate rows when the audit store is opened again", () => {
    seedPreSplitAudit(tmp, "written before the split");

    openAudit(tmp).close();
    // Reopening the index recreates its own tables; the audit store must not
    // treat that as a fresh legacy table to adopt.
    openIndex(tmp).close();
    db = openAudit(tmp);

    expect(queryAuditRows(db, "2026-08-01T00:00:00.000Z")).toHaveLength(1);
  });

  test("should add request_id to an existing audit.sqlite3 that predates it (AC4)", () => {
    const preFeature = new Database(join(tmp, "audit.sqlite3"), { create: true });
    preFeature.run(`CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      query TEXT NOT NULL,
      retrieval TEXT NOT NULL DEFAULT 'lexical',
      degraded_from TEXT,
      degradation_reason TEXT,
      candidates TEXT NOT NULL,
      latency_ms INTEGER NOT NULL
    )`);
    preFeature.run(
      "INSERT INTO audit (ts, query, retrieval, candidates, latency_ms) VALUES (?, ?, ?, ?, ?)",
      ["2026-08-20T00:00:00.000Z", "written before request_id shipped", "lexical", "[]", 9],
    );
    preFeature.close();

    db = openAudit(tmp);

    const columns = (db.query("PRAGMA table_info(audit)").all() as { name: string }[]).map((c) => c.name);
    expect(columns).toContain("request_id");

    const rows = queryAuditRows(db, "2026-08-01T00:00:00.000Z");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.query).toBe("written before request_id shipped");
    expect(rows[0]!.request_id).toBeNull();

    insertAudit(db, {
      ts: "2026-08-28T00:00:00.000Z",
      request_id: "11111111-1111-4111-8111-111111111111",
      query: "written after the migration",
      retrieval: "lexical",
      candidates: [],
      latency_ms: 4,
    });
    const afterInsert = queryAuditRows(db, "2026-08-01T00:00:00.000Z");
    expect(afterInsert).toHaveLength(2);
    expect(afterInsert[1]!.request_id).toBe("11111111-1111-4111-8111-111111111111");
  });

  test("should adopt a legacy audit table that predates the retrieval columns", () => {
    const legacy = new Database(join(tmp, "index.sqlite3"), { create: true });
    legacy.run(`CREATE TABLE audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      query TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK (outcome IN ('matched', 'ambiguous', 'no_match')),
      degraded INTEGER NOT NULL,
      candidates TEXT NOT NULL,
      selected_skill_id TEXT,
      latency_ms INTEGER NOT NULL
    )`);
    legacy.run(
      `INSERT INTO audit (ts, query, outcome, degraded, candidates, selected_skill_id, latency_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        "2026-07-01T10:00:00.000Z",
        "matched query",
        "matched",
        0,
        JSON.stringify([{ skill_id: "matched-skill", score: 0.95 }]),
        "matched-skill",
        15,
      ],
    );
    legacy.close();

    db = openAudit(tmp);

    const rows = queryAuditRows(db, "2026-07-01T00:00:00.000Z");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.query).toBe("matched query");
    expect(rows[0]!.retrieval).toBe("lexical");
    // queryAuditRows omits these keys rather than nulling them (src/stats.ts:186).
    expect(rows[0]!.degraded_from).toBeUndefined();
    expect(rows[0]!.degradation_reason).toBeUndefined();
  });
  test("should create a fetch table in audit.sqlite3", () => {
    db = openAudit(tmp);

    const fetchTables = db
      .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'fetch'")
      .all();

    expect(fetchTables).toHaveLength(1);
  });

  test("should round-trip a fetch row through insertFetch (AC8)", () => {
    db = openAudit(tmp);

    insertFetch(db, {
      ts: "2026-08-28T00:00:00.000Z",
      skill_id: "csv-formatter",
      request_id: "11111111-1111-4111-8111-111111111111",
      resolve_audit_id: 7,
      rank_at_resolve: 2,
    });

    const rows = db.query("SELECT * FROM fetch ORDER BY id DESC LIMIT 1").all() as any[];

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      id: 1,
      ts: "2026-08-28T00:00:00.000Z",
      skill_id: "csv-formatter",
      request_id: "11111111-1111-4111-8111-111111111111",
      resolve_audit_id: 7,
      rank_at_resolve: 2,
    });
  });

  test("insertFetch defaults request_id, resolve_audit_id, and rank_at_resolve to null when omitted (AC6)", () => {
    db = openAudit(tmp);

    insertFetch(db, {
      ts: "2026-08-28T00:00:00.000Z",
      skill_id: "csv-formatter",
    });

    const rows = db.query("SELECT * FROM fetch ORDER BY id DESC LIMIT 1").all() as any[];

    expect(rows[0]).toEqual({
      id: 1,
      ts: "2026-08-28T00:00:00.000Z",
      skill_id: "csv-formatter",
      request_id: null,
      resolve_audit_id: null,
      rank_at_resolve: null,
    });
  });

  test("getAuditRowByRequestId returns the audit row's id and candidates for a known request_id (AC5)", () => {
    db = openAudit(tmp);

    insertAudit(db, {
      ts: "2026-08-28T00:00:00.000Z",
      request_id: "22222222-2222-4222-8222-222222222222",
      query: "convert a spreadsheet to markdown",
      retrieval: "hybrid",
      candidates: [{ skill_id: "csv-formatter", score: 0.92 }],
      latency_ms: 42,
    });

    const found = getAuditRowByRequestId(db, "22222222-2222-4222-8222-222222222222");

    expect(found).not.toBeNull();
    expect(found!.id).toBeGreaterThan(0);
    expect(found!.candidates).toEqual([{ skill_id: "csv-formatter", score: 0.92 }]);
  });

  test("getAuditRowByRequestId returns null for an unknown or malformed request_id (AC7)", () => {
    db = openAudit(tmp);

    expect(getAuditRowByRequestId(db, "no-such-request-id")).toBeNull();
  });

  describe("pruneAudit (AC13, AC16)", () => {
    test("does nothing when retention_days is 0", () => {
      db = openAudit(tmp);
      const now = new Date("2026-08-28T00:00:00.000Z");
      insertAudit(db, {
        ts: "2020-01-01T00:00:00.000Z",
        query: "ancient query",
        retrieval: "lexical",
        candidates: [],
        latency_ms: 1,
      });
      insertFetch(db, { ts: "2020-01-01T00:00:00.000Z", skill_id: "some-skill" });

      const result = pruneAudit(db, 0, now);

      expect(result).toEqual({ audit_deleted: 0, fetch_deleted: 0 });
      expect((db.query("SELECT count(*) AS n FROM audit").get() as { n: number }).n).toBe(1);
      expect((db.query("SELECT count(*) AS n FROM fetch").get() as { n: number }).n).toBe(1);
    });

    test("deletes audit rows older than the retention window and keeps newer ones", () => {
      db = openAudit(tmp);
      const now = new Date("2026-08-28T00:00:00.000Z");
      insertAudit(db, {
        ts: "2026-01-01T00:00:00.000Z",
        query: "old enough to prune",
        retrieval: "lexical",
        candidates: [],
        latency_ms: 1,
      });
      insertAudit(db, {
        ts: "2026-08-27T00:00:00.000Z",
        query: "recent enough to keep",
        retrieval: "lexical",
        candidates: [],
        latency_ms: 1,
      });

      const result = pruneAudit(db, 30, now);

      expect(result.audit_deleted).toBe(1);
      const remaining = db.query("SELECT query FROM audit").all() as { query: string }[];
      expect(remaining.map((r) => r.query)).toEqual(["recent enough to keep"]);
    });

    test("deletes fetch rows older than the retention window independently of their resolve row's age (AC13)", () => {
      db = openAudit(tmp);
      const now = new Date("2026-08-28T00:00:00.000Z");
      insertAudit(db, {
        ts: "2026-08-27T00:00:00.000Z",
        query: "recent resolve",
        retrieval: "lexical",
        candidates: [],
        latency_ms: 1,
      });
      insertFetch(db, { ts: "2026-01-01T00:00:00.000Z", skill_id: "old-fetch" });
      insertFetch(db, { ts: "2026-08-27T00:00:00.000Z", skill_id: "recent-fetch" });

      const result = pruneAudit(db, 30, now);

      expect(result.fetch_deleted).toBe(1);
      const remaining = db.query("SELECT skill_id FROM fetch").all() as { skill_id: string }[];
      expect(remaining.map((r) => r.skill_id)).toEqual(["recent-fetch"]);
    });

    test("a fetch whose resolve row has been pruned reports as uncorrelated rather than erroring (AC13)", () => {
      db = openAudit(tmp);
      const now = new Date("2026-08-28T00:00:00.000Z");
      insertAudit(db, {
        ts: "2026-01-01T00:00:00.000Z",
        request_id: "33333333-3333-4333-8333-333333333333",
        query: "pruned resolve",
        retrieval: "lexical",
        candidates: [{ skill_id: "some-skill", score: 0.5 }],
        latency_ms: 1,
      });
      insertFetch(db, {
        ts: "2026-08-27T00:00:00.000Z",
        skill_id: "some-skill",
        request_id: "33333333-3333-4333-8333-333333333333",
        resolve_audit_id: 1,
        rank_at_resolve: 1,
      });

      pruneAudit(db, 30, now);

      expect(getAuditRowByRequestId(db, "33333333-3333-4333-8333-333333333333")).toBeNull();
      const fetchRow = db.query("SELECT resolve_audit_id FROM fetch").get() as { resolve_audit_id: number };
      expect(fetchRow.resolve_audit_id).toBe(1);
    });

    test("reclaims file space via incremental vacuum after deleting rows", () => {
      db = openAudit(tmp);
      const now = new Date("2026-08-28T00:00:00.000Z");
      for (let i = 0; i < 200; i++) {
        insertAudit(db, {
          ts: "2020-01-01T00:00:00.000Z",
          query: `bulk query ${i}`,
          retrieval: "lexical",
          candidates: [{ skill_id: "some-skill", score: 0.5 }],
          latency_ms: 1,
        });
      }

      pruneAudit(db, 30, now);

      const freelist = db.query("PRAGMA freelist_count").get() as { freelist_count: number };
      expect(freelist.freelist_count).toBe(0);
    });
  });

  describe("audit table schema and legacy migration", () => {
    test("adoption normalizes a legacy audit schema with outcome NOT NULL CHECK and selected_skill_id", () => {
      const stateDir = mkdtempSync(join(tmpdir(), "skillmux-audit-adopt-"));
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

      // 3. Open the audit store, which adopts and normalizes the legacy table
      const migratedDb = openAudit(stateDir);

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
        request_id: null,
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
        request_id: null,
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
        request_id: null,
        query: "no match query",
        retrieval: "lexical",
        degraded_from: null,
        degradation_reason: null,
        candidates: JSON.stringify([]),
        latency_ms: 5,
      });

      migratedDb.close();

      // 4. Verify idempotent reopen
      const reopenedDb = openAudit(stateDir);
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
        request_id: null,
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
