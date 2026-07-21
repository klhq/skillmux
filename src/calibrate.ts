import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { z } from "zod";

export { generateDataset, type GenerateDatasetOptions } from "./dataset-generator";

// ---------------------------------------------------------------------------

// Decision-policy dataset types (AC1)
// ---------------------------------------------------------------------------

export type DecisionSplit = "tune" | "test";
export type DecisionOutcome = "matched" | "ambiguous" | "no_match";

export interface DecisionCase {
  query: string;
  split: DecisionSplit;
  expected_outcome: DecisionOutcome;
  relevant_skill_ids: string[];
}

// ---------------------------------------------------------------------------
// Raw Zod schema — field-level validation only (cross-field rules below)
// ---------------------------------------------------------------------------

const rawCaseSchema = z.object({
  query: z.string(),
  split: z.enum(["tune", "test"]),
  expected_outcome: z.enum(["matched", "ambiguous", "no_match"]),
  relevant_skill_ids: z.array(z.string()),
}).strict();

type RawCase = z.infer<typeof rawCaseSchema>;

// ---------------------------------------------------------------------------
// Cross-field validation helpers
// ---------------------------------------------------------------------------

function validateCase(raw: RawCase, idx: number): DecisionCase {
  if (!raw.query) {
    throw new Error(`Validation error at case ${idx}: field "query" must be a non-empty string`);
  }

  const { expected_outcome, relevant_skill_ids } = raw;

  if (expected_outcome === "matched") {
    if (relevant_skill_ids.length !== 1) {
      throw new Error(
        `Validation error at case ${idx}: field "relevant_skill_ids" must contain exactly one entry for outcome "matched"`,
      );
    }
  } else if (expected_outcome === "ambiguous") {
    if (relevant_skill_ids.length < 1) {
      throw new Error(
        `Validation error at case ${idx}: field "relevant_skill_ids" must contain at least one entry for outcome "ambiguous"`,
      );
    }
  } else {
    // no_match
    if (relevant_skill_ids.length !== 0) {
      throw new Error(
        `Validation error at case ${idx}: field "relevant_skill_ids" must be empty for outcome "no_match"`,
      );
    }
  }

  return raw as DecisionCase;
}

// ---------------------------------------------------------------------------
// Dataset-level completeness checks
// ---------------------------------------------------------------------------

type SplitOutcomeSet = Record<DecisionSplit, Set<DecisionOutcome>>;

function validateDatasetCompleteness(cases: DecisionCase[]): void {
  const present: SplitOutcomeSet = { tune: new Set(), test: new Set() };

  for (const c of cases) {
    present[c.split].add(c.expected_outcome);
  }

  for (const split of ["tune", "test"] as DecisionSplit[]) {
    if (present[split].size === 0) {
      throw new Error(
        `Dataset must include cases for both "tune" and "test" splits — missing "${split}"`,
      );
    }
    for (const outcome of ["matched", "ambiguous", "no_match"] as DecisionOutcome[]) {
      if (!present[split].has(outcome)) {
        throw new Error(
          `Dataset must include "${outcome}" cases in the "${split}" split`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse and validate an array of raw objects as a decision-policy dataset.
 *
 * Throws a descriptive error (including case index and field name) on the
 * first validation failure. Validates:
 *   - Required fields and their types/enums (Zod)
 *   - Cross-field constraints (matched → exactly 1 skill, ambiguous → ≥1,
 *     no_match → 0)
 *   - Dataset completeness (both splits, all outcome types in each split)
 */
export function loadDecisionCases(raw: unknown[]): DecisionCase[] {
  const parsed: DecisionCase[] = [];

  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    const result = rawCaseSchema.safeParse(item);

    if (!result.success) {
      const firstIssue = result.error.issues[0]!;
      const fieldPath = firstIssue.path.join(".") || "unknown";
      throw new Error(
        `Validation error at case ${i}: field "${fieldPath}" — ${firstIssue.message}`,
      );
    }

    parsed.push(validateCase(result.data, i));
  }

  validateDatasetCompleteness(parsed);
  return parsed;
}

/**
 * Read a JSON file from disk and validate it as a decision-policy dataset.
 * Throws if the file cannot be read or the contents fail validation.
 */
export function loadDecisionCasesFromFile(path: string): DecisionCase[] {
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown[];
  return loadDecisionCases(raw);
}

// ---------------------------------------------------------------------------
// Calibration run — types (AC2, AC3, AC4)
// ---------------------------------------------------------------------------

export interface CandidateDoc {
  skill_id: string;
  text: string;
}

/** A single cached observation for one query. */
export interface QueryObservation {
  query: string;
  split: DecisionSplit;
  expected_outcome: DecisionOutcome;
  relevant_skill_ids: string[];
  /** Candidates in descending score order after reranking. */
  ranked: Array<{ skill_id: string; score: number }>;
}

export interface SelectedThresholds {
  match_score: number;
  match_margin: number;
  candidate_floor: number;
}

export interface CalibrationMetrics {
  auto_match_precision: number;
  auto_match_coverage: number;
  shortlist_recall_at_5: number;
  false_no_match_rate: number;
}

export interface ConfusionMatrix {
  matched: Record<DecisionOutcome, number>;
  ambiguous: Record<DecisionOutcome, number>;
  no_match: Record<DecisionOutcome, number>;
}

export interface CalibrationTestMetrics extends CalibrationMetrics {
  confusion_matrix: ConfusionMatrix;
}

export type CalibrationStatus = "completed" | "failed_gates";

export interface CalibrationResult {
  status: CalibrationStatus;
  observations: QueryObservation[];
  selected_thresholds?: SelectedThresholds;
  tune_metrics?: CalibrationMetrics;
  test_metrics?: CalibrationTestMetrics;
}

export interface RunCalibrationOptions {
  cases: DecisionCase[];
  getCandidates: (query: string) => Promise<CandidateDoc[]>;
  reranker:
    | ((query: string, docs: CandidateDoc[]) => Promise<number[]>)
    | undefined;
  /** Default: 0.99 */
  minAutoMatchPrecision?: number;
  /** Default: 0.95 */
  minShortlistRecallAt5?: number;
}

// ---------------------------------------------------------------------------
// Decision simulation using cached observations
// ---------------------------------------------------------------------------

type SimulatedDecision = "matched" | "ambiguous" | "no_match";

function simulateDecision(
  obs: QueryObservation,
  thresholds: SelectedThresholds,
  candidateLimit: number,
): SimulatedDecision {
  const { match_score, match_margin, candidate_floor } = thresholds;
  const eligible = obs.ranked.filter((c) => c.score >= candidate_floor);
  if (eligible.length === 0) return "no_match";

  const top = eligible[0]!;
  const second = obs.ranked[1];
  const margin = second ? top.score - second.score : top.score;

  if (top.score >= match_score && margin >= match_margin) return "matched";
  if (eligible.slice(0, candidateLimit).length > 0) return "ambiguous";
  return "no_match";
}

function computeMetrics(
  observations: QueryObservation[],
  thresholds: SelectedThresholds,
  candidateLimit = 5,
): CalibrationMetrics {
  let autoMatchCount = 0;
  let correctAutoMatch = 0;
  let shortlistHit = 0;
  let falseNoMatch = 0;
  const matchableCases = observations.filter((o) => o.expected_outcome !== "no_match");

  for (const obs of observations) {
    const decision = simulateDecision(obs, thresholds, candidateLimit);
    if (decision === "matched") {
      autoMatchCount++;
      // Correct if the top candidate is in relevant_skill_ids
      const top = obs.ranked[0];
      if (top && obs.relevant_skill_ids.includes(top.skill_id)) correctAutoMatch++;
    }
    if (obs.expected_outcome !== "no_match") {
      // Shortlist recall: at least one relevant skill in top 5
      const top5 = obs.ranked.slice(0, 5).map((c) => c.skill_id);
      if (obs.relevant_skill_ids.some((id) => top5.includes(id))) shortlistHit++;
    }
    if (obs.expected_outcome !== "no_match" && decision === "no_match") {
      falseNoMatch++;
    }
  }

  const auto_match_precision = autoMatchCount === 0 ? 1.0 : correctAutoMatch / autoMatchCount;
  const auto_match_coverage = matchableCases.length === 0
    ? 0
    : autoMatchCount / matchableCases.length;
  const shortlist_recall_at_5 = matchableCases.length === 0
    ? 1.0
    : shortlistHit / matchableCases.length;
  const false_no_match_rate = matchableCases.length === 0
    ? 0
    : falseNoMatch / matchableCases.length;

  return { auto_match_precision, auto_match_coverage, shortlist_recall_at_5, false_no_match_rate };
}

function computeTestMetrics(
  observations: QueryObservation[],
  thresholds: SelectedThresholds,
  candidateLimit = 5,
): CalibrationTestMetrics {
  const base = computeMetrics(observations, thresholds, candidateLimit);

  // Build confusion matrix: rows = expected, cols = predicted
  const emptyRow = (): Record<DecisionOutcome, number> => ({ matched: 0, ambiguous: 0, no_match: 0 });
  const matrix: ConfusionMatrix = { matched: emptyRow(), ambiguous: emptyRow(), no_match: emptyRow() };

  for (const obs of observations) {
    const predicted = simulateDecision(obs, thresholds, candidateLimit);
    matrix[obs.expected_outcome][predicted]++;
  }

  return { ...base, confusion_matrix: matrix };
}

// ---------------------------------------------------------------------------
// Threshold search space derivation (AC3)
// ---------------------------------------------------------------------------

function uniqueSorted(values: number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

function deriveThresholdCandidates(observations: QueryObservation[]): {
  scoreBreakpoints: number[];
  marginBreakpoints: number[];
  floorBreakpoints: number[];
} {
  const scores: number[] = [];
  const margins: number[] = [];

  for (const obs of observations) {
    if (obs.ranked.length === 0) continue;
    const top = obs.ranked[0]!;
    scores.push(top.score);
    const second = obs.ranked[1];
    margins.push(second ? top.score - second.score : top.score);
  }

  // Breakpoints: observed values + a small epsilon step below each
  const epsilon = 0.001;
  const scoreBreakpoints = uniqueSorted([
    ...scores.map((s) => Math.max(0, s - epsilon)),
    ...scores,
  ]);
  const marginBreakpoints = uniqueSorted([
    ...margins.map((m) => Math.max(0, m - epsilon)),
    ...margins,
  ]);
  const floorBreakpoints = uniqueSorted([
    ...scores.map((s) => Math.max(0, s - epsilon)),
    ...scores,
  ]);

  return { scoreBreakpoints, marginBreakpoints, floorBreakpoints };
}

// ---------------------------------------------------------------------------
// Deterministic optimizer (AC3)
// ---------------------------------------------------------------------------

/**
 * Find the threshold triple that:
 *   1. Satisfies minAutoMatchPrecision AND minShortlistRecallAt5 gates
 *   2. Among those: maximizes auto_match_coverage
 *   3. Ties broken by: higher auto_match_precision, then higher shortlist_recall_at_5,
 *      then lower auto_match_coverage (as coverage the tiebreak)
 */
function selectThresholds(
  tuneObservations: QueryObservation[],
  gates: { minAutoMatchPrecision: number; minShortlistRecallAt5: number },
  candidateLimit: number,
): SelectedThresholds | undefined {
  const { scoreBreakpoints, marginBreakpoints, floorBreakpoints } =
    deriveThresholdCandidates(tuneObservations);

  let best:
    | { thresholds: SelectedThresholds; metrics: CalibrationMetrics }
    | undefined;

  for (const floor of floorBreakpoints) {
    for (const score of scoreBreakpoints) {
      if (score < floor) continue;
      for (const margin of marginBreakpoints) {
        const candidate: SelectedThresholds = { match_score: score, match_margin: margin, candidate_floor: floor };
        const m = computeMetrics(tuneObservations, candidate, candidateLimit);

        if (
          m.auto_match_precision < gates.minAutoMatchPrecision ||
          m.shortlist_recall_at_5 < gates.minShortlistRecallAt5
        ) {
          continue;
        }

        if (!best) {
          best = { thresholds: candidate, metrics: m };
          continue;
        }

        // Prefer higher coverage, then higher precision, then higher recall, then lower coverage (impossible but symmetry)
        const bm = best.metrics;
        if (m.auto_match_coverage > bm.auto_match_coverage) {
          best = { thresholds: candidate, metrics: m };
        } else if (m.auto_match_coverage === bm.auto_match_coverage) {
          if (m.auto_match_precision > bm.auto_match_precision) {
            best = { thresholds: candidate, metrics: m };
          } else if (
            m.auto_match_precision === bm.auto_match_precision &&
            m.shortlist_recall_at_5 > bm.shortlist_recall_at_5
          ) {
            best = { thresholds: candidate, metrics: m };
          }
        }
      }
    }
  }

  return best?.thresholds;
}

// ---------------------------------------------------------------------------
// Public API — runCalibration (AC2, AC3, AC4)
// ---------------------------------------------------------------------------

/**
 * Run an in-memory calibration:
 *  1. Require a configured reranker (AC2)
 *  2. Collect and cache per-query observations via hybrid retrieval + reranking (AC2)
 *  3. Search cached observations for optimal thresholds (AC3)
 *  4. Evaluate selected thresholds on untouched test split (AC4)
 */
export async function runCalibration(opts: RunCalibrationOptions): Promise<CalibrationResult> {
  const {
    cases,
    getCandidates,
    reranker,
    minAutoMatchPrecision = 0.99,
    minShortlistRecallAt5 = 0.95,
  } = opts;

  if (!reranker) {
    throw new Error(
      "A configured reranker is required to run calibration. " +
        "Configure inference.reranker in your TOML config.",
    );
  }

  // --- Step 1: Cache observations (reranker called exactly once per query) ---
  const observations: QueryObservation[] = [];
  for (const c of cases) {
    const docs = await getCandidates(c.query);
    const scores = await reranker(c.query, docs);
    const ranked = docs
      .map((d, i) => ({ skill_id: d.skill_id, score: scores[i] ?? 0 }))
      .sort((a, b) => b.score - a.score);
    observations.push({
      query: c.query,
      split: c.split,
      expected_outcome: c.expected_outcome,
      relevant_skill_ids: c.relevant_skill_ids,
      ranked,
    });
  }

  // --- Step 2: Select thresholds from tune split only ---
  const tuneObs = observations.filter((o) => o.split === "tune");
  const selected = selectThresholds(
    tuneObs,
    { minAutoMatchPrecision, minShortlistRecallAt5 },
    5,
  );

  if (!selected) {
    return { status: "failed_gates", observations };
  }

  // --- Step 3: Report tune metrics ---
  const tune_metrics = computeMetrics(tuneObs, selected);

  // --- Step 4: Evaluate untouched test split ---
  const testObs = observations.filter((o) => o.split === "test");
  const test_metrics = computeTestMetrics(testObs, selected);

  return { status: "completed", observations, selected_thresholds: selected, tune_metrics, test_metrics };
}

// ---------------------------------------------------------------------------
// SQLite evidence store (AC5, AC6)
// ---------------------------------------------------------------------------

/**
 * All fields stored for a single calibration run.
 * SQLite is evidence and history only — never read on the resolve_skill path.
 */
export interface CalibrationRunRecord {
  run_id: string;
  created_at: string;
  status: CalibrationStatus;
  reranker_fingerprint: string;
  embedding_fingerprint: string;
  corpus_fingerprint: string;
  dataset_hash: string;
  min_auto_match_precision: number;
  min_shortlist_recall_at_5: number;
  selected_thresholds?: SelectedThresholds;
  tune_metrics?: CalibrationMetrics;
  test_metrics?: CalibrationTestMetrics;
  observations: QueryObservation[];
}

/** Summary row returned by listCalibrationRuns (no observations blob). */
export interface CalibrationRunSummary {
  run_id: string;
  created_at: string;
  status: CalibrationStatus;
  reranker_fingerprint: string;
  embedding_fingerprint: string;
  corpus_fingerprint: string;
  dataset_hash: string;
  min_auto_match_precision: number;
  min_shortlist_recall_at_5: number;
}

/**
 * Open (or create) the calibration evidence database in `stateDir`.
 * Uses a separate `calibrate.sqlite3` file — never the index.sqlite3 used
 * on the resolve_skill request path.
 */
export function openCalibrateDb(stateDir: string): Database {
  mkdirSync(stateDir, { recursive: true });
  const db = new Database(join(stateDir, "calibrate.sqlite3"), { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA busy_timeout = 2000");
  db.run(`CREATE TABLE IF NOT EXISTS calibration_runs (
    run_id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('completed', 'failed_gates')),
    reranker_fingerprint TEXT NOT NULL,
    embedding_fingerprint TEXT NOT NULL,
    corpus_fingerprint TEXT NOT NULL,
    dataset_hash TEXT NOT NULL,
    min_auto_match_precision REAL NOT NULL,
    min_shortlist_recall_at_5 REAL NOT NULL,
    selected_thresholds TEXT,
    tune_metrics TEXT,
    test_metrics TEXT,
    observations TEXT NOT NULL
  )`);
  return db;
}

/** Persist a calibration run (all fields) to the evidence store. */
export function insertCalibrationRun(db: Database, run: CalibrationRunRecord): void {
  db.run(
    `INSERT INTO calibration_runs (
      run_id, created_at, status,
      reranker_fingerprint, embedding_fingerprint, corpus_fingerprint, dataset_hash,
      min_auto_match_precision, min_shortlist_recall_at_5,
      selected_thresholds, tune_metrics, test_metrics, observations
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      run.run_id,
      run.created_at,
      run.status,
      run.reranker_fingerprint,
      run.embedding_fingerprint,
      run.corpus_fingerprint,
      run.dataset_hash,
      run.min_auto_match_precision,
      run.min_shortlist_recall_at_5,
      run.selected_thresholds != null ? JSON.stringify(run.selected_thresholds) : null,
      run.tune_metrics != null ? JSON.stringify(run.tune_metrics) : null,
      run.test_metrics != null ? JSON.stringify(run.test_metrics) : null,
      JSON.stringify(run.observations),
    ],
  );
}

interface RawCalibrationRow {
  run_id: string;
  created_at: string;
  status: string;
  reranker_fingerprint: string;
  embedding_fingerprint: string;
  corpus_fingerprint: string;
  dataset_hash: string;
  min_auto_match_precision: number;
  min_shortlist_recall_at_5: number;
  selected_thresholds: string | null;
  tune_metrics: string | null;
  test_metrics: string | null;
  observations: string;
}

function rowToRecord(row: RawCalibrationRow): CalibrationRunRecord {
  return {
    run_id: row.run_id,
    created_at: row.created_at,
    status: row.status as CalibrationStatus,
    reranker_fingerprint: row.reranker_fingerprint,
    embedding_fingerprint: row.embedding_fingerprint,
    corpus_fingerprint: row.corpus_fingerprint,
    dataset_hash: row.dataset_hash,
    min_auto_match_precision: row.min_auto_match_precision,
    min_shortlist_recall_at_5: row.min_shortlist_recall_at_5,
    selected_thresholds: row.selected_thresholds != null
      ? (JSON.parse(row.selected_thresholds) as SelectedThresholds)
      : undefined,
    tune_metrics: row.tune_metrics != null
      ? (JSON.parse(row.tune_metrics) as CalibrationMetrics)
      : undefined,
    test_metrics: row.test_metrics != null
      ? (JSON.parse(row.test_metrics) as CalibrationTestMetrics)
      : undefined,
    observations: JSON.parse(row.observations) as QueryObservation[],
  };
}

/** Retrieve a full run record by run_id. Returns null if not found. */
export function getCalibrationRun(db: Database, runId: string): CalibrationRunRecord | null {
  const row = db
    .query("SELECT * FROM calibration_runs WHERE run_id = ?")
    .get(runId) as RawCalibrationRow | null;
  return row ? rowToRecord(row) : null;
}

/** List all runs ordered by created_at descending (excludes observations blob). */
export function listCalibrationRuns(db: Database): CalibrationRunSummary[] {
  return db
    .query(
      `SELECT run_id, created_at, status,
        reranker_fingerprint, embedding_fingerprint, corpus_fingerprint, dataset_hash,
        min_auto_match_precision, min_shortlist_recall_at_5
       FROM calibration_runs ORDER BY created_at DESC`,
    )
    .all() as CalibrationRunSummary[];
}

// ---------------------------------------------------------------------------
// calibrate apply — gated TOML write (AC6, AC7)
// ---------------------------------------------------------------------------

/** Structured error for apply rejections — always includes a reason string. */
export class ApplyCalibrationError extends Error {
  constructor(
    message: string,
    public readonly reason: string,
  ) {
    super(message);
    this.name = "ApplyCalibrationError";
  }
}

export interface ApplyCalibrationOptions {
  /** If provided, checked against run.reranker_fingerprint; mismatch rejects. */
  currentRerankerFingerprint?: string;
  /** If provided, checked against run.embedding_fingerprint; mismatch rejects. */
  currentEmbeddingFingerprint?: string;
  /** If provided, checked against run.corpus_fingerprint; mismatch rejects. */
  currentCorpusFingerprint?: string;
  /**
   * Keys currently masked by environment variable overrides.
   * If any of the three threshold keys appear here, the apply is rejected
   * (the write would be invisible at runtime).
   */
  maskedEnvKeys?: string[];
}

const THRESHOLD_KEYS = [
  "inference.thresholds.match_score",
  "inference.thresholds.match_margin",
  "inference.thresholds.candidate_floor",
] as const;

/**
 * Atomically write calibration thresholds and provenance to the TOML config.
 *
 * Rejects (ApplyCalibrationError) when:
 *   - run_id not found in the evidence store
 *   - run status is failed_gates
 *   - any fingerprint check fails (reranker, embedding, corpus)
 *   - any threshold key is masked by an environment variable override
 *
 * On success: reads the existing TOML, patches [inference.thresholds] and
 * [inference.calibration] sections, and atomically writes via rename.
 */
export async function applyCalibrationRun(
  db: Database,
  runId: string,
  tomlPath: string,
  opts: ApplyCalibrationOptions,
): Promise<void> {
  // --- Gate 1: run must exist ---
  const run = getCalibrationRun(db, runId);
  if (!run) {
    throw new ApplyCalibrationError(
      `Calibration run "${runId}" not found`,
      "run_not_found",
    );
  }

  // --- Gate 2: run must have completed successfully ---
  if (run.status !== "completed" || !run.selected_thresholds) {
    throw new ApplyCalibrationError(
      `Calibration run "${runId}" has status "${run.status}" and cannot be applied`,
      "failed_gates",
    );
  }

  // --- Gate 3: fingerprint staleness ---
  if (
    opts.currentRerankerFingerprint !== undefined &&
    opts.currentRerankerFingerprint !== run.reranker_fingerprint
  ) {
    throw new ApplyCalibrationError(
      `Reranker fingerprint mismatch: run was calibrated with "${run.reranker_fingerprint}" ` +
        `but current config has "${opts.currentRerankerFingerprint}"`,
      "stale_reranker_fingerprint",
    );
  }
  if (
    opts.currentEmbeddingFingerprint !== undefined &&
    opts.currentEmbeddingFingerprint !== run.embedding_fingerprint
  ) {
    throw new ApplyCalibrationError(
      `Embedding fingerprint mismatch: run was calibrated with "${run.embedding_fingerprint}" ` +
        `but current config has "${opts.currentEmbeddingFingerprint}"`,
      "stale_embedding_fingerprint",
    );
  }
  if (
    opts.currentCorpusFingerprint !== undefined &&
    opts.currentCorpusFingerprint !== run.corpus_fingerprint
  ) {
    throw new ApplyCalibrationError(
      `Corpus fingerprint mismatch: run was calibrated against "${run.corpus_fingerprint}" ` +
        `but current vault has "${opts.currentCorpusFingerprint}"`,
      "stale_corpus_fingerprint",
    );
  }

  // --- Gate 4: env-masked key check (AC7) ---
  const masked = opts.maskedEnvKeys ?? [];
  const maskedThresholdKeys = THRESHOLD_KEYS.filter((k) => masked.includes(k));
  if (maskedThresholdKeys.length > 0) {
    throw new ApplyCalibrationError(
      `Cannot apply: the following threshold keys are masked by environment variable overrides ` +
        `and the TOML write would be invisible at runtime: ${maskedThresholdKeys.join(", ")}`,
      "env_masked_keys",
    );
  }

  // --- Atomic TOML write ---
  const { match_score, match_margin, candidate_floor } = run.selected_thresholds;

  const existing = await Bun.file(tomlPath).text();
  const patched = patchToml(existing, runId, match_score, match_margin, candidate_floor);

  // Write to a temp file then rename for atomicity
  const tmpPath = `${tomlPath}.${process.pid}.tmp`;
  await Bun.write(tmpPath, patched);
  const { renameSync } = await import("node:fs");
  renameSync(tmpPath, tomlPath);
}

// ---------------------------------------------------------------------------
// TOML patch helpers (surgical text manipulation)
// ---------------------------------------------------------------------------

/**
 * Patch an existing TOML string to set [inference.thresholds] values and
 * add/update [inference.calibration] with run_id.
 *
 * Strategy:
 *   1. Replace any existing [inference.thresholds] section content
 *   2. Add/replace [inference.calibration] section
 */
function patchToml(
  source: string,
  runId: string,
  matchScore: number,
  matchMargin: number,
  candidateFloor: number,
): string {
  const thresholdsBlock = `[inference.thresholds]\nmatch_score = ${matchScore}\nmatch_margin = ${matchMargin}\ncandidate_floor = ${candidateFloor}\n`;
  const calibrationBlock = `[inference.calibration]\nrun_id = "${runId}"\n`;

  // Remove existing [inference.thresholds] section
  let result = removeSectionBlock(source, "[inference.thresholds]");
  // Remove existing [inference.calibration] section
  result = removeSectionBlock(result, "[inference.calibration]");
  // Append both sections
  result = result.trimEnd() + "\n\n" + thresholdsBlock + "\n" + calibrationBlock;
  return result;
}

/**
 * Remove a TOML section header and all lines until the next section header
 * (or end of file). Matches exact header string at start of line.
 */
function removeSectionBlock(source: string, header: string): string {
  const lines = source.split("\n");
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    if (line.trimEnd() === header) {
      skipping = true;
      continue;
    }
    if (skipping && line.startsWith("[")) {
      skipping = false;
    }
    if (!skipping) out.push(line);
  }
  return out.join("\n");
}


