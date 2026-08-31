import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AuditCandidate, AuditRow } from "./types";
import type { VaultSkill } from "./vault";

export interface SkillRow {
  skill_id: string;
  title: string;
  description: string;
  aliases: string;
  content_sha256: string;
}

export function openAudit(stateDir: string): Database {
  mkdirSync(stateDir, { recursive: true });
  const db = new Database(join(stateDir, "audit.sqlite3"), { create: true });
  // auto_vacuum only takes on an empty database, so it must precede both the
  // journal-mode switch and any CREATE TABLE. It is what lets a retention
  // prune reclaim space without a full VACUUM.
  db.run("PRAGMA auto_vacuum = INCREMENTAL");
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA busy_timeout = 2000");
  db.run(`CREATE TABLE IF NOT EXISTS audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    request_id TEXT,
    query TEXT NOT NULL,
    retrieval TEXT NOT NULL DEFAULT 'lexical',
    degraded_from TEXT,
    degradation_reason TEXT,
    candidates TEXT NOT NULL,
    latency_ms INTEGER NOT NULL
  )`);
  // CREATE TABLE IF NOT EXISTS no-ops on a table opened from before request_id
  // existed (AC4), so add it explicitly when missing.
  const auditColumns = new Set(
    (db.query("PRAGMA table_info(audit)").all() as { name: string }[]).map((c) => c.name),
  );
  if (!auditColumns.has("request_id")) {
    db.run("ALTER TABLE audit ADD COLUMN request_id TEXT");
  }
  db.run(`CREATE TABLE IF NOT EXISTS fetch (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    skill_id TEXT NOT NULL,
    request_id TEXT,
    resolve_audit_id INTEGER,
    rank_at_resolve INTEGER
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS admin_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    changes TEXT NOT NULL,
    resulting_revision TEXT NOT NULL,
    row_hash TEXT NOT NULL,
    prev_row_hash TEXT
  )`);
  adoptAuditFromIndex(db, stateDir);
  return db;
}

// Audit rows used to live in index.sqlite3. Move any that remain there into the
// audit store, then drop the old table so the index carries no user queries.
function adoptAuditFromIndex(db: Database, stateDir: string): void {
  const indexPath = join(stateDir, "index.sqlite3");
  if (!existsSync(indexPath)) return;

  db.run("ATTACH DATABASE ? AS legacy", [indexPath]);
  try {
    const legacyAudit = db
      .query("SELECT name FROM legacy.sqlite_master WHERE type = 'table' AND name = 'audit'")
      .get();
    if (!legacyAudit) return;

    // Older audit tables predate the retrieval columns and carry outcome /
    // degraded / selected_skill_id instead. Select what is actually there and
    // let the canonical defaults stand in for the rest.
    const legacyColumns = new Set(
      (db.query("PRAGMA legacy.table_info(audit)").all() as { name: string }[]).map((c) => c.name),
    );
    const retrieval = legacyColumns.has("retrieval") ? "COALESCE(retrieval, 'lexical')" : "'lexical'";
    const degradedFrom = legacyColumns.has("degraded_from") ? "degraded_from" : "NULL";
    const degradationReason = legacyColumns.has("degradation_reason") ? "degradation_reason" : "NULL";

    // SQLite commits atomically across attached databases, so the copy and the
    // drop either both land or neither does.
    db.transaction(() => {
      db.run(`INSERT INTO audit (ts, query, retrieval, degraded_from, degradation_reason, candidates, latency_ms)
        SELECT ts, query, ${retrieval}, ${degradedFrom}, ${degradationReason}, candidates, latency_ms FROM legacy.audit`);
      db.run("DROP TABLE legacy.audit");
    })();
  } finally {
    db.run("DETACH DATABASE legacy");
  }
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
    embedding_fingerprint TEXT NOT NULL DEFAULT '',
    dim INTEGER NOT NULL,
    vec BLOB NOT NULL
  )`);
  const vectorColumns = db.query("PRAGMA table_info(vectors)").all() as { name: string }[];
  if (!vectorColumns.some((column) => column.name === "embedding_fingerprint")) {
    db.run("ALTER TABLE vectors ADD COLUMN embedding_fingerprint TEXT NOT NULL DEFAULT ''");
  }
  // Audit rows live in audit.sqlite3; openAudit adopts any left here.
  db.run(`CREATE TABLE IF NOT EXISTS index_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
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

export function findExactMatch(db: Database, query: string): SkillRow | null {
  const cleanQuery = query.trim().toLowerCase();
  return db
    .query(
      `SELECT * FROM skills 
       WHERE lower(skill_id) = ? 
          OR lower(title) = ? 
          OR ' ' || lower(aliases) || ' ' LIKE ?`,
    )
    .get(cleanQuery, cleanQuery, `% ${cleanQuery} %`) as SkillRow | null;
}

export function getIndexMeta(db: Database, key: string): string | null {
  const row = db
    .query("SELECT value FROM index_meta WHERE key = ?")
    .get(key) as { value: string } | null;
  return row ? row.value : null;
}

export function setIndexMeta(db: Database, key: string, value: string): void {
  db.run(
    `INSERT INTO index_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, value],
  );
}

export function upsertVector(
  db: Database,
  skillId: string,
  contentSha256: string,
  embeddingFingerprint: string,
  vec: Float32Array,
): void {
  db.run(
    `INSERT INTO vectors (skill_id, content_sha256, embedding_fingerprint, dim, vec) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(skill_id) DO UPDATE SET
       content_sha256 = excluded.content_sha256,
       embedding_fingerprint = excluded.embedding_fingerprint,
       dim = excluded.dim,
       vec = excluded.vec`,
    [skillId, contentSha256, embeddingFingerprint, vec.length, new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength)],
  );
}

/**
 * Skills with no usable stored vector: none at all, content changed since
 * embedding, or embedded at a different dimension than currently configured.
 */
export function skillsNeedingVectors(db: Database, dimension: number, embeddingFingerprint: string): SkillRow[] {
  return db
    .query(
      `SELECT s.* FROM skills s
       LEFT JOIN vectors v ON v.skill_id = s.skill_id
          AND v.content_sha256 = s.content_sha256
          AND v.dim = ?
          AND v.embedding_fingerprint = ?
        WHERE v.skill_id IS NULL`,
    )
    .all(dimension, embeddingFingerprint) as SkillRow[];
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
  request_id?: string | null;
  query: string;
  retrieval: AuditRow["retrieval"];
  degraded_from?: string | null;
  degradation_reason?: string | null;
  candidates: AuditCandidate[];
  latency_ms: number;
}

export function insertAudit(db: Database, row: AuditInsert): void {
  db.run(
    `INSERT INTO audit (ts, request_id, query, retrieval, degraded_from, degradation_reason, candidates, latency_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.ts,
      row.request_id ?? null,
      row.query,
      row.retrieval,
      row.degraded_from ?? null,
      row.degradation_reason ?? null,
      JSON.stringify(row.candidates),
      row.latency_ms,
    ],
  );
}

/**
 * Correlation lookup for AC5/AC7: looks up the resolve that produced
 * `requestId`, or null when it names no known resolve (including malformed
 * input, which is never validated at the boundary per AC7).
 */
export function getAuditRowByRequestId(
  db: Database,
  requestId: string,
): { id: number; candidates: AuditCandidate[] } | null {
  const row = db
    .query("SELECT id, candidates FROM audit WHERE request_id = ?")
    .get(requestId) as { id: number; candidates: string } | null;
  if (!row) return null;
  return { id: row.id, candidates: JSON.parse(row.candidates) as AuditCandidate[] };
}

export interface FetchInsert {
  ts: string;
  skill_id: string;
  request_id?: string | null;
  resolve_audit_id?: number | null;
  rank_at_resolve?: number | null;
}

export function insertFetch(db: Database, row: FetchInsert): void {
  db.run(
    `INSERT INTO fetch (ts, skill_id, request_id, resolve_audit_id, rank_at_resolve)
     VALUES (?, ?, ?, ?, ?)`,
    [
      row.ts,
      row.skill_id,
      row.request_id ?? null,
      row.resolve_audit_id ?? null,
      row.rank_at_resolve ?? null,
    ],
  );
}

export interface PruneResult {
  audit_deleted: number;
  fetch_deleted: number;
  admin_audit_deleted: number;
}

/**
 * Deletes resolve, fetch, and admin_audit rows with ts before `cutoffIso`,
 * each by its own timestamp; no FK ties them, so a fetch outliving its
 * resolve row simply reads back uncorrelated (AC7's existing null path).
 * admin_audit shares this cutoff rather than a separate retention config
 * (AC10) — its hash chain is unaffected since pruning only ever removes the
 * oldest rows, never rows in the middle of the chain. Reclaims the freed
 * pages with an incremental vacuum, which only touches audit.sqlite3 (AC16).
 */
export function pruneAuditBefore(db: Database, cutoffIso: string): PruneResult {
  const auditResult = db.run("DELETE FROM audit WHERE ts < ?", [cutoffIso]);
  const fetchResult = db.run("DELETE FROM fetch WHERE ts < ?", [cutoffIso]);
  const adminAuditResult = db.run("DELETE FROM admin_audit WHERE ts < ?", [cutoffIso]);
  db.run("PRAGMA incremental_vacuum");

  return {
    audit_deleted: auditResult.changes,
    fetch_deleted: fetchResult.changes,
    admin_audit_deleted: adminAuditResult.changes,
  };
}

/** AC12: retentionDays <= 0 disables pruning entirely. */
export function pruneAudit(db: Database, retentionDays: number, now: Date = new Date()): PruneResult {
  if (retentionDays <= 0) return { audit_deleted: 0, fetch_deleted: 0, admin_audit_deleted: 0 };
  const cutoff = new Date(now.getTime() - retentionDays * 86_400_000).toISOString();
  return pruneAuditBefore(db, cutoff);
}

export interface AdminAuditChange {
  key: string;
  old_value: unknown;
  new_value: unknown;
}

export interface AdminAuditInsert {
  ts: string;
  changes: AdminAuditChange[];
  resulting_revision: string;
}

export interface AdminAuditRow {
  id: number;
  ts: string;
  changes: AdminAuditChange[];
  resulting_revision: string;
  row_hash: string;
  prev_row_hash: string | null;
}

function computeAdminAuditRowHash(
  prevRowHash: string | null,
  fields: { ts: string; changes: AdminAuditChange[]; resulting_revision: string },
): string {
  const payload = JSON.stringify({ prev_row_hash: prevRowHash, ...fields });
  return createHash("sha256").update(payload).digest("hex");
}

/**
 * Appends one tamper-evident admin_audit row, chaining its hash to the
 * previous row's hash (or null for the first row) so any out-of-band
 * edit/delete breaks the chain — see verifyAdminAuditChain.
 */
export function insertAdminAuditRow(db: Database, row: AdminAuditInsert): AdminAuditRow {
  const prevRow = db
    .query("SELECT row_hash FROM admin_audit ORDER BY id DESC LIMIT 1")
    .get() as { row_hash: string } | null;
  const prevRowHash = prevRow?.row_hash ?? null;
  const rowHash = computeAdminAuditRowHash(prevRowHash, row);

  db.run(
    `INSERT INTO admin_audit (ts, changes, resulting_revision, row_hash, prev_row_hash)
     VALUES (?, ?, ?, ?, ?)`,
    [row.ts, JSON.stringify(row.changes), row.resulting_revision, rowHash, prevRowHash],
  );

  const inserted = db.query("SELECT last_insert_rowid() AS id").get() as { id: number };
  return {
    id: inserted.id,
    ts: row.ts,
    changes: row.changes,
    resulting_revision: row.resulting_revision,
    row_hash: rowHash,
    prev_row_hash: prevRowHash,
  };
}

export interface AdminAuditChainResult {
  valid: boolean;
  broken_at_id: number | null;
}

/** Walks admin_audit in insertion order and reports whether the hash chain is unbroken. */
export function verifyAdminAuditChain(db: Database): AdminAuditChainResult {
  const rows = db
    .query("SELECT id, ts, changes, resulting_revision, row_hash, prev_row_hash FROM admin_audit ORDER BY id ASC")
    .all() as { id: number; ts: string; changes: string; resulting_revision: string; row_hash: string; prev_row_hash: string | null }[];

  let expectedPrevHash: string | null = null;
  for (const row of rows) {
    if (row.prev_row_hash !== expectedPrevHash) {
      return { valid: false, broken_at_id: row.id };
    }
    const recomputed = computeAdminAuditRowHash(expectedPrevHash, {
      ts: row.ts,
      changes: JSON.parse(row.changes),
      resulting_revision: row.resulting_revision,
    });
    if (recomputed !== row.row_hash) {
      return { valid: false, broken_at_id: row.id };
    }
    expectedPrevHash = row.row_hash;
  }
  return { valid: true, broken_at_id: null };
}

/** Dry-run counterpart of pruneAuditBefore: counts without deleting (AC15). */
export function countPrunable(db: Database, cutoffIso: string): PruneResult {
  const auditRow = db.query("SELECT count(*) AS n FROM audit WHERE ts < ?").get(cutoffIso) as { n: number };
  const fetchRow = db.query("SELECT count(*) AS n FROM fetch WHERE ts < ?").get(cutoffIso) as { n: number };
  const adminAuditRow = db
    .query("SELECT count(*) AS n FROM admin_audit WHERE ts < ?")
    .get(cutoffIso) as { n: number };
  return { audit_deleted: auditRow.n, fetch_deleted: fetchRow.n, admin_audit_deleted: adminAuditRow.n };
}
