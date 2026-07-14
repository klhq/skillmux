import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AuditCandidate } from "./types";
import type { VaultSkill } from "./vault";

export interface SkillRow {
  skill_id: string;
  title: string;
  description: string;
  aliases: string;
  content_sha256: string;
}

export function openIndex(stateDir: string): Database {
  mkdirSync(stateDir, { recursive: true });
  const db = new Database(join(stateDir, "index.sqlite3"), { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run(`CREATE TABLE IF NOT EXISTS skills (
    skill_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    aliases TEXT NOT NULL,
    content_sha256 TEXT NOT NULL
  )`);
  db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS skills_fts USING fts5(
    skill_id UNINDEXED, title, description, aliases,
    tokenize = 'unicode61 remove_diacritics 2'
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    query TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('matched', 'ambiguous', 'no_match')),
    degraded INTEGER NOT NULL,
    candidates TEXT NOT NULL,
    selected_skill_id TEXT,
    latency_ms INTEGER NOT NULL
  )`);
  return db;
}

export function upsertSkill(db: Database, skill: VaultSkill): void {
  const aliases = skill.aliases.join(" ");
  db.transaction(() => {
    db.run("DELETE FROM skills WHERE skill_id = ?", [skill.skill_id]);
    db.run("DELETE FROM skills_fts WHERE skill_id = ?", [skill.skill_id]);
    db.run(
      "INSERT INTO skills (skill_id, title, description, aliases, content_sha256) VALUES (?, ?, ?, ?, ?)",
      [skill.skill_id, skill.title, skill.description, aliases, skill.content_sha256],
    );
    db.run(
      "INSERT INTO skills_fts (skill_id, title, description, aliases) VALUES (?, ?, ?, ?)",
      [skill.skill_id, skill.title, skill.description, aliases],
    );
  })();
}

export function ingestVault(db: Database, skills: VaultSkill[]): void {
  db.transaction(() => {
    db.run("DELETE FROM skills");
    db.run("DELETE FROM skills_fts");
    for (const skill of skills) {
      const aliases = skill.aliases.join(" ");
      db.run(
        "INSERT INTO skills (skill_id, title, description, aliases, content_sha256) VALUES (?, ?, ?, ?, ?)",
        [skill.skill_id, skill.title, skill.description, aliases, skill.content_sha256],
      );
      db.run(
        "INSERT INTO skills_fts (skill_id, title, description, aliases) VALUES (?, ?, ?, ?)",
        [skill.skill_id, skill.title, skill.description, aliases],
      );
    }
  })();
}

export function skillCount(db: Database): number {
  return (db.query("SELECT count(*) AS n FROM skills").get() as { n: number }).n;
}

export function getSkillRow(db: Database, skillId: string): SkillRow | null {
  return db.query("SELECT * FROM skills WHERE skill_id = ?").get(skillId) as SkillRow | null;
}

/** Sanitize free text into an FTS5 OR-query; returns null when no usable terms remain. */
export function toFtsQuery(text: string): string | null {
  const terms = [
    ...new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length >= 2),
    ),
  ];
  if (terms.length === 0) return null;
  return terms.map((t) => `"${t}"`).join(" OR ");
}

export function ftsSearch(db: Database, text: string, k: number): SkillRow[] {
  const query = toFtsQuery(text);
  if (query === null) return [];
  return db
    .query(
      `SELECT s.* FROM skills_fts f
       JOIN skills s ON s.skill_id = f.skill_id
       WHERE skills_fts MATCH ?
       ORDER BY bm25(skills_fts) LIMIT ?`,
    )
    .all(query, k) as SkillRow[];
}

export interface AuditInsert {
  ts: string;
  query: string;
  outcome: string;
  degraded: boolean;
  candidates: AuditCandidate[];
  selected_skill_id: string | null;
  latency_ms: number;
}

export function insertAudit(db: Database, row: AuditInsert): void {
  db.run(
    `INSERT INTO audit (ts, query, outcome, degraded, candidates, selected_skill_id, latency_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      row.ts,
      row.query,
      row.outcome,
      row.degraded ? 1 : 0,
      JSON.stringify(row.candidates),
      row.selected_skill_id,
      row.latency_ms,
    ],
  );
}
