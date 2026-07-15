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
  db.run("PRAGMA busy_timeout = 2000");
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
  db.run(`CREATE TABLE IF NOT EXISTS vectors (
    skill_id TEXT PRIMARY KEY,
    content_sha256 TEXT NOT NULL,
    dim INTEGER NOT NULL,
    vec BLOB NOT NULL
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

export function toSkillRow(skill: VaultSkill): SkillRow {
  return {
    skill_id: skill.skill_id,
    title: skill.title,
    description: skill.description,
    aliases: skill.aliases.join(" "),
    content_sha256: skill.content_sha256,
  };
}

/** Replace the whole lexical index with `rows`; drops vectors of removed skills. */
export function replaceSkills(db: Database, rows: SkillRow[]): void {
  db.transaction(() => {
    db.run("DELETE FROM skills");
    db.run("DELETE FROM skills_fts");
    for (const row of rows) {
      db.run(
        "INSERT INTO skills (skill_id, title, description, aliases, content_sha256) VALUES (?, ?, ?, ?, ?)",
        [row.skill_id, row.title, row.description, row.aliases, row.content_sha256],
      );
      db.run(
        "INSERT INTO skills_fts (skill_id, title, description, aliases) VALUES (?, ?, ?, ?)",
        [row.skill_id, row.title, row.description, row.aliases],
      );
    }
    db.run("DELETE FROM vectors WHERE skill_id NOT IN (SELECT skill_id FROM skills)");
  })();
}

export function ingestVault(db: Database, skills: VaultSkill[]): void {
  replaceSkills(db, skills.map(toSkillRow));
}

export function deleteSkill(db: Database, skillId: string): void {
  db.transaction(() => {
    db.run("DELETE FROM skills WHERE skill_id = ?", [skillId]);
    db.run("DELETE FROM skills_fts WHERE skill_id = ?", [skillId]);
    db.run("DELETE FROM vectors WHERE skill_id = ?", [skillId]);
  })();
}

export function skillCount(db: Database): number {
  return (db.query("SELECT count(*) AS n FROM skills").get() as { n: number }).n;
}

export function getSkillRow(db: Database, skillId: string): SkillRow | null {
  return db.query("SELECT * FROM skills WHERE skill_id = ?").get(skillId) as SkillRow | null;
}

/**
 * Sanitize free text into an FTS5 OR-query; returns null when no usable terms
 * remain. Terms keep any Unicode letters/digits (CJK included) so non-ASCII
 * queries still get lexical recall — unicode61 tokenizes contiguous CJK runs
 * as single tokens, so matching works at that granularity.
 */
export function toFtsQuery(text: string): string | null {
  const terms = [
    ...new Set(
      text
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
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

export function upsertVector(
  db: Database,
  skillId: string,
  contentSha256: string,
  vec: Float32Array,
): void {
  db.run(
    `INSERT INTO vectors (skill_id, content_sha256, dim, vec) VALUES (?, ?, ?, ?)
     ON CONFLICT(skill_id) DO UPDATE SET
       content_sha256 = excluded.content_sha256, dim = excluded.dim, vec = excluded.vec`,
    [skillId, contentSha256, vec.length, new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength)],
  );
}

/**
 * Skills with no usable stored vector: none at all, content changed since
 * embedding, or embedded at a different dimension than currently configured.
 */
export function skillsNeedingVectors(db: Database, dimension: number): SkillRow[] {
  return db
    .query(
      `SELECT s.* FROM skills s
       LEFT JOIN vectors v ON v.skill_id = s.skill_id
         AND v.content_sha256 = s.content_sha256
         AND v.dim = ?
       WHERE v.skill_id IS NULL`,
    )
    .all(dimension) as SkillRow[];
}

function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** Brute-force cosine over every stored vector (vault is ~100 skills; no ANN). */
export function vectorTopK(db: Database, query: Float32Array, k: number): SkillRow[] {
  const rows = db
    .query(
      `SELECT s.skill_id, s.title, s.description, s.aliases, s.content_sha256, v.vec
       FROM vectors v JOIN skills s ON s.skill_id = v.skill_id`,
    )
    .all() as (SkillRow & { vec: Uint8Array })[];
  return rows
    .map(({ vec, ...row }) => ({
      row,
      score: cosine(query, new Float32Array(vec.buffer, vec.byteOffset, vec.byteLength / 4)),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((r) => r.row);
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
