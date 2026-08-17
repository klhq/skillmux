import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { z } from "zod";
import { decideResolveOutcome } from "./decision";
import type { AuditRow, RankedCandidate } from "./types";

export { generateDataset, type GenerateDatasetOptions } from "./dataset-generator";

// ---------------------------------------------------------------------------

// Decision-policy dataset types (AC1)
// ---------------------------------------------------------------------------

export type DecisionSplit = "tune" | "test";
export type DecisionOutcome = "matched" | "ambiguous" | "no_match";

export interface DecisionCaseProvenance {
  version: 1;
  source: "authored" | "audit_import";
  review_status: "human_labelled" | "unreviewed";
  query_storage: "raw" | "redacted";
  audit_id?: number;
  labelled_at?: string;
}

export interface DecisionCase {
  query: string;
  split: DecisionSplit;
  expected_outcome: DecisionOutcome;
  relevant_skill_ids: string[];
  provenance?: DecisionCaseProvenance;
}

// ---------------------------------------------------------------------------
// Raw Zod schema — field-level validation only (cross-field rules below)
// ---------------------------------------------------------------------------

const rawCaseSchema = z.object({
  query: z.string(),
  split: z.enum(["tune", "test"]),
  expected_outcome: z.enum(["matched", "ambiguous", "no_match"]),
  relevant_skill_ids: z.array(z.string()),
  provenance: z.object({
    version: z.literal(1),
    source: z.enum(["authored", "audit_import"]),
    review_status: z.enum(["human_labelled", "unreviewed"]),
    query_storage: z.enum(["raw", "redacted"]),
    audit_id: z.number().int().positive().optional(),
    labelled_at: z.string().datetime().optional(),
  }).strict().optional(),
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
  const provenance: DecisionCaseProvenance = raw.provenance ?? {
    version: 1,
    source: "authored",
    review_status: "human_labelled",
    query_storage: "raw",
  };

  if (provenance.source === "audit_import") {
    if (provenance.audit_id === undefined) {
      throw new Error(
        `Validation error at case ${idx}: imported field "provenance.audit_id" is required`,
      );
    }
    if (provenance.review_status !== "human_labelled" || !provenance.labelled_at) {
      throw new Error(
        `Validation error at case ${idx}: imported audit case is unreviewed; human label and "provenance.labelled_at" are required for certification`,
      );
    }
  }

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

  return { ...raw, provenance };
}

export interface AuditFeedbackLabel {
  split: DecisionSplit;
  expected_outcome: DecisionOutcome;
  relevant_skill_ids: string[];
  labelled_at: string;
}

export type AuditQueryPrivacy =
  | { include_raw_query: true }
  | { include_raw_query: false; redacted_query: string };

/** Import an audit outcome only after a separate human label is supplied. */
export function importLabelledAuditCase(
  audit: AuditRow,
  label: AuditFeedbackLabel,
  privacy: AuditQueryPrivacy,
): DecisionCase {
  const query = privacy.include_raw_query ? audit.query : privacy.redacted_query.trim();
  if (!query) {
    throw new Error("A non-empty redacted_query is required when raw audit queries are excluded");
  }
  const parsed = rawCaseSchema.parse({
    query,
    split: label.split,
    expected_outcome: label.expected_outcome,
    relevant_skill_ids: label.relevant_skill_ids,
    provenance: {
      version: 1,
      source: "audit_import",
      review_status: "human_labelled",
      query_storage: privacy.include_raw_query ? "raw" : "redacted",
      audit_id: audit.id,
      labelled_at: label.labelled_at,
    },
  });
  return validateCase(parsed, audit.id);
}

export interface DatasetProvenanceSummary {
  version: 1;
  human_labelled_case_count: number;
  imported_labelled_case_count: number;
  imported_unreviewed_case_count: number;
  raw_query_case_count: number;
  redacted_query_case_count: number;
}

export function summarizeDatasetProvenance(
  cases: DecisionCase[],
): DatasetProvenanceSummary {
  const provenance = (item: DecisionCase): DecisionCaseProvenance =>
    item.provenance ?? {
      version: 1,
      source: "authored",
      review_status: "human_labelled",
      query_storage: "raw",
    };
  return {
    version: 1,
    human_labelled_case_count:
      cases.filter((item) => provenance(item).review_status === "human_labelled").length,
    imported_labelled_case_count:
      cases.filter((item) =>
        provenance(item).source === "audit_import" &&
        provenance(item).review_status === "human_labelled"
      ).length,
    imported_unreviewed_case_count:
      cases.filter((item) =>
        provenance(item).source === "audit_import" &&
        provenance(item).review_status === "unreviewed"
      ).length,
    raw_query_case_count:
      cases.filter((item) => provenance(item).query_storage === "raw").length,
    redacted_query_case_count:
      cases.filter((item) => provenance(item).query_storage === "redacted").length,
  };
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
export function loadDecisionCases(
  raw: unknown[],
  validSkillIds?: Iterable<string>,
): DecisionCase[] {
  const parsed: DecisionCase[] = [];
  const validIds = validSkillIds ? new Set(validSkillIds) : undefined;

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

    const parsedCase = validateCase(result.data, i);
    if (validIds) {
      for (const skillId of parsedCase.relevant_skill_ids) {
        if (!validIds.has(skillId)) {
          throw new Error(
            `Validation error at case ${i}: field "relevant_skill_ids" references unknown vault skill "${skillId}"`,
          );
        }
      }
    }
    parsed.push(parsedCase);
  }

  validateDatasetCompleteness(parsed);
  return parsed;
}

/**
 * Read a JSON file from disk and validate it as a decision-policy dataset.
 * Throws if the file cannot be read or the contents fail validation.
 */
export function loadDecisionCasesFromFile(
  path: string,
  validSkillIds?: Iterable<string>,
): DecisionCase[] {
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown[];
  return loadDecisionCases(raw, validSkillIds);
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
  auto_match_precision_lower_bound: number;
  auto_match_coverage: number;
  auto_match_count: number;
  correct_auto_match_count: number;
  retrieval_recall_at_k: number;
  delivered_shortlist_recall_at_k: number;
}

export interface ConfusionMatrix {
  matched: Record<DecisionOutcome, number>;
  ambiguous: Record<DecisionOutcome, number>;
  no_match: Record<DecisionOutcome, number>;
}

export interface CalibrationTestMetrics extends CalibrationMetrics {
  confusion_matrix: ConfusionMatrix;
}

export type CalibrationStatus = "running" | "completed" | "failed_gates";
export type CalibrationFailureReason =
  | "recall_precondition_failed"
  | "precision_floor_unreachable"
  | "no_coverage"
  | "insufficient_sample"
  | "test_certification_failed";

export interface CalibrationResult {
  status: CalibrationStatus;
  failed_reason?: CalibrationFailureReason;
  observations: QueryObservation[];
  selected_thresholds?: SelectedThresholds;
  tune_metrics?: CalibrationMetrics;
  test_metrics?: CalibrationTestMetrics;
}

export interface RunCalibrationOptions {
  cases: DecisionCase[];
  getCandidates?: (query: string) => Promise<CandidateDoc[]>;
  /** Production hook: candidates already scored by the shared retrieval pipeline. */
  getRankedCandidates?: (
    query: string,
  ) => Promise<Array<{ skill_id: string; score: number }>>;
  reranker:
    | ((query: string, docs: CandidateDoc[]) => Promise<number[]>)
    | undefined;
  /** Default: 0.99 */
  minAutoMatchPrecision?: number;
  /** Default: 0.95 */
  minRetrievalRecallAtK?: number;
  /** Default: minRetrievalRecallAtK */
  minDeliveredShortlistRecallAtK?: number;
  /** Default: 30 */
  minAutoMatchCount?: number;
  candidateLimit: number;
  /** Default: 4 */
  concurrency?: number;
  initialObservations?: Map<number, QueryObservation> | QueryObservation[];
  onProgress?: (completed: number, total: number) => void;
  onObservation?: (
    observation: QueryObservation,
    caseIndex: number,
    completedCount: number,
    totalCount: number,
  ) => void | Promise<void>;
  onObservationsReady?: () => void;
}

// ---------------------------------------------------------------------------
// Decision simulation using cached observations
// ---------------------------------------------------------------------------

function decideObservation(
  obs: QueryObservation,
  thresholds: SelectedThresholds,
  candidateLimit: number,
) {
  const candidates: RankedCandidate[] = obs.ranked.map((candidate) => ({
    ...candidate,
    title: candidate.skill_id,
    description: "",
  }));
  return decideResolveOutcome({
    reranked: true,
    candidates,
    thresholds: { ...thresholds, candidate_limit: candidateLimit },
  });
}

function computeMetrics(
  observations: QueryObservation[],
  thresholds: SelectedThresholds,
  candidateLimit: number,
): CalibrationMetrics {
  let autoMatchCount = 0;
  let correctAutoMatch = 0;
  let retrievalHit = 0;
  let deliveredHit = 0;
  const matchableCases = observations.filter((o) => o.expected_outcome !== "no_match");
  const expectedMatches = observations.filter((o) => o.expected_outcome === "matched");

  for (const obs of observations) {
    const decision = decideObservation(obs, thresholds, candidateLimit);
    if (decision.outcome === "matched") {
      autoMatchCount++;
      const top = obs.ranked[0];
      if (
        obs.expected_outcome === "matched" &&
        top?.skill_id === obs.relevant_skill_ids[0]
      ) {
        correctAutoMatch++;
      }
    }
    if (obs.expected_outcome !== "no_match") {
      const topK = obs.ranked.slice(0, candidateLimit).map((c) => c.skill_id);
      if (obs.relevant_skill_ids.some((id) => topK.includes(id))) retrievalHit++;
      const deliveredIds = decision.outcome === "matched"
        ? [decision.skill_id]
        : decision.outcome === "ambiguous"
          ? decision.candidates.map((candidate) => candidate.skill_id)
          : [];
      if (obs.relevant_skill_ids.some((id) => deliveredIds.includes(id))) deliveredHit++;
    }
  }

  const auto_match_precision = autoMatchCount === 0 ? 0 : correctAutoMatch / autoMatchCount;
  const auto_match_precision_lower_bound = wilsonLowerBound(correctAutoMatch, autoMatchCount);
  const auto_match_coverage = expectedMatches.length === 0
    ? 0
    : correctAutoMatch / expectedMatches.length;
  const retrieval_recall_at_k = matchableCases.length === 0
    ? 1.0
    : retrievalHit / matchableCases.length;
  const delivered_shortlist_recall_at_k = matchableCases.length === 0
    ? 1.0
    : deliveredHit / matchableCases.length;

  return {
    auto_match_precision,
    auto_match_precision_lower_bound,
    auto_match_coverage,
    auto_match_count: autoMatchCount,
    correct_auto_match_count: correctAutoMatch,
    retrieval_recall_at_k,
    delivered_shortlist_recall_at_k,
  };
}

/** 95% Wilson score lower confidence bound for a binomial proportion. */
export function wilsonLowerBound(successes: number, total: number): number {
  if (total === 0) return 0;
  const z = 1.959963984540054;
  const proportion = successes / total;
  const zSquared = z * z;
  const denominator = 1 + zSquared / total;
  const centre = proportion + zSquared / (2 * total);
  const adjustment = z * Math.sqrt(
    (proportion * (1 - proportion) + zSquared / (4 * total)) / total,
  );
  return Math.max(0, (centre - adjustment) / denominator);
}

/**
 * Computes the maximum attainable 95% Wilson lower bound on auto-match precision
 * for the tune split subject to minAutoMatchCount and the number of matched tune cases.
 * Under perfect ranking/classification (zero false positives), at most all true matched
 * tune cases can be auto-matched.
 */
export function computeMaxAttainablePrecisionLowerBound(
  cases: DecisionCase[],
  minAutoMatchCount: number,
): { tuneMatchedCount: number; maxAttainablePrecision: number } {
  const tuneMatchedCount = cases.filter(
    (c) => c.split === "tune" && c.expected_outcome === "matched",
  ).length;
  const effectiveTrials = Math.max(tuneMatchedCount, minAutoMatchCount);
  const maxAttainablePrecision = wilsonLowerBound(tuneMatchedCount, effectiveTrials);
  return { tuneMatchedCount, maxAttainablePrecision };
}

/**
 * Asserts that the requested auto-match precision and count gates are mathematically
 * attainable on the given dataset's tune split before inference begins.
 */
export function assertCalibrationFeasibility(
  cases: DecisionCase[],
  gates: { minAutoMatchPrecision: number; minAutoMatchCount: number },
): void {
  const { tuneMatchedCount, maxAttainablePrecision } =
    computeMaxAttainablePrecisionLowerBound(cases, gates.minAutoMatchCount);
  if (maxAttainablePrecision < gates.minAutoMatchPrecision) {
    throw new Error(
      `Requested calibration gates are mathematically unattainable on this dataset: ` +
      `min_auto_match_precision=${gates.minAutoMatchPrecision} requires more evidence than the ` +
      `tune split provides (${tuneMatchedCount} matched cases, min_auto_match_count=${gates.minAutoMatchCount}). ` +
      `The maximum attainable 95% Wilson lower bound under perfect classification is ` +
      `${maxAttainablePrecision.toFixed(4)}. ` +
      `Lower --min-auto-match-precision or supply a larger dataset.`,
    );
  }
}

function computeTestMetrics(
  observations: QueryObservation[],
  thresholds: SelectedThresholds,
  candidateLimit: number,
): CalibrationTestMetrics {
  const base = computeMetrics(observations, thresholds, candidateLimit);

  // Build confusion matrix: rows = expected, cols = predicted
  const emptyRow = (): Record<DecisionOutcome, number> => ({ matched: 0, ambiguous: 0, no_match: 0 });
  const matrix: ConfusionMatrix = { matched: emptyRow(), ambiguous: emptyRow(), no_match: emptyRow() };

  for (const obs of observations) {
    const predicted = decideObservation(obs, thresholds, candidateLimit);
    matrix[obs.expected_outcome][predicted.outcome]++;
  }

  return { ...base, confusion_matrix: matrix };
}

// ---------------------------------------------------------------------------
// Threshold search space derivation (AC3)
// ---------------------------------------------------------------------------

function uniqueSorted(values: number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

/** Smallest representable number greater than value. */
function nextUp(value: number): number {
  if (!Number.isFinite(value)) return value;
  if (Object.is(value, -0)) value = 0;
  const buffer = new ArrayBuffer(8);
  const float = new Float64Array(buffer);
  const bits = new BigUint64Array(buffer);
  float[0] = value;
  bits[0] = bits[0]! + (value >= 0 ? 1n : -1n);
  return float[0]!;
}

function deriveThresholdCandidates(observations: QueryObservation[]): {
  scoreBreakpoints: number[];
  marginBreakpoints: number[];
  floorBreakpoints: number[];
} {
  const scores: number[] = [0];
  const margins: number[] = [];
  const floors: number[] = [0];

  for (const obs of observations) {
    if (obs.ranked.length === 0) continue;
    const top = obs.ranked[0]!;
    scores.push(top.score);
    const second = obs.ranked[1];
    margins.push(second ? top.score - second.score : top.score);
    // candidate_floor is inclusive, so the policy changes only immediately
    // above an observed score. Use that transition to make every breakpoint
    // capable of trimming at least one non-top candidate.
    for (const candidate of obs.ranked.slice(1)) floors.push(nextUp(candidate.score));
  }

  const scoreBreakpoints = uniqueSorted(scores);
  const marginBreakpoints = uniqueSorted([0, ...margins]);
  const floorBreakpoints = uniqueSorted(floors);

  return { scoreBreakpoints, marginBreakpoints, floorBreakpoints };
}

// ---------------------------------------------------------------------------
// Deterministic optimizer (AC3)
// ---------------------------------------------------------------------------

/**
 * Find the threshold triple that:
 *   1. Satisfies Wilson precision, sample-count, coverage, and delivered-recall gates
 *   2. Among those: maximizes auto_match_coverage
 *   3. Ties break on confidence, delivered recall, maximal safe shortlist trimming,
 *      then deterministic lower match thresholds
 */
interface CalibrationGates {
  minAutoMatchPrecision: number;
  minRetrievalRecallAtK: number;
  minDeliveredShortlistRecallAtK: number;
  minAutoMatchCount: number;
}

function metricsPass(metrics: CalibrationMetrics, gates: CalibrationGates): boolean {
  return (
    metrics.auto_match_precision_lower_bound >= gates.minAutoMatchPrecision &&
    metrics.auto_match_count >= gates.minAutoMatchCount &&
    metrics.auto_match_coverage > 0 &&
    metrics.delivered_shortlist_recall_at_k >= gates.minDeliveredShortlistRecallAtK
  );
}

function betterPolicy(
  candidate: { thresholds: SelectedThresholds; metrics: CalibrationMetrics },
  best: { thresholds: SelectedThresholds; metrics: CalibrationMetrics } | undefined,
): boolean {
  if (!best) return true;
  const a = candidate.metrics;
  const b = best.metrics;
  if (a.auto_match_coverage !== b.auto_match_coverage) {
    return a.auto_match_coverage > b.auto_match_coverage;
  }
  if (a.auto_match_precision_lower_bound !== b.auto_match_precision_lower_bound) {
    return a.auto_match_precision_lower_bound > b.auto_match_precision_lower_bound;
  }
  if (a.delivered_shortlist_recall_at_k !== b.delivered_shortlist_recall_at_k) {
    return a.delivered_shortlist_recall_at_k > b.delivered_shortlist_recall_at_k;
  }
  if (candidate.thresholds.candidate_floor !== best.thresholds.candidate_floor) {
    return candidate.thresholds.candidate_floor > best.thresholds.candidate_floor;
  }
  if (candidate.thresholds.match_score !== best.thresholds.match_score) {
    return candidate.thresholds.match_score < best.thresholds.match_score;
  }
  if (candidate.thresholds.match_margin !== best.thresholds.match_margin) {
    return candidate.thresholds.match_margin < best.thresholds.match_margin;
  }
  return false;
}

function sampledFloorIndexes(length: number, maxSamples = 32): number[] {
  if (length <= maxSamples) return Array.from({ length }, (_, index) => index);
  return uniqueSorted(
    Array.from({ length: maxSamples }, (_, index) =>
      Math.round(index * (length - 1) / (maxSamples - 1))),
  );
}

function selectThresholds(
  tuneObservations: QueryObservation[],
  gates: CalibrationGates,
  candidateLimit: number,
): { selected?: SelectedThresholds; reason?: CalibrationFailureReason } {
  const { scoreBreakpoints, marginBreakpoints, floorBreakpoints } =
    deriveThresholdCandidates(tuneObservations);

  let best:
    | { thresholds: SelectedThresholds; metrics: CalibrationMetrics }
    | undefined;
  let sawCoverage = false;
  let sawSample = false;
  let sawPrecision = false;
  const scoreIndexes = new Map(scoreBreakpoints.map((value, index) => [value, index]));
  const marginIndexes = new Map(marginBreakpoints.map((value, index) => [value, index]));
  const width = marginBreakpoints.length;
  const expectedMatchCount = tuneObservations.filter(
    (observation) => observation.expected_outcome === "matched",
  ).length;
  const matchable = tuneObservations.filter(
    (observation) => observation.expected_outcome !== "no_match",
  );
  const retrievalHits = matchable.filter((observation) => {
    const ids = observation.ranked.slice(0, candidateLimit).map((candidate) => candidate.skill_id);
    return observation.relevant_skill_ids.some((id) => ids.includes(id));
  }).length;
  const retrievalRecall = matchable.length === 0 ? 1 : retrievalHits / matchable.length;

  const evaluateFloor = (floorIndex: number) => {
    const floor = floorBreakpoints[floorIndex]!;
    const cells = scoreBreakpoints.length * width;
    const autoMatches = new Uint32Array(cells);
    const correctMatches = new Uint32Array(cells);
    const deliveredDelta = new Int32Array(cells);
    let ambiguousDeliveredHits = 0;

    for (const observation of tuneObservations) {
      const top = observation.ranked[0];
      if (!top || top.score < floor) continue;
      const second = observation.ranked[1];
      const margin = second ? top.score - second.score : top.score;
      const cell = scoreIndexes.get(top.score)! * width + marginIndexes.get(margin)!;
      autoMatches[cell] = autoMatches[cell]! + 1;
      const correct = (
        observation.expected_outcome === "matched" &&
        top.skill_id === observation.relevant_skill_ids[0]
      );
      if (correct) correctMatches[cell] = correctMatches[cell]! + 1;

      if (observation.expected_outcome !== "no_match") {
        const ambiguousIds = observation.ranked
          .filter((candidate) => candidate.score >= floor)
          .slice(0, candidateLimit)
          .map((candidate) => candidate.skill_id);
        const ambiguousHit = observation.relevant_skill_ids.some(
          (id) => ambiguousIds.includes(id),
        );
        const matchedHit = observation.relevant_skill_ids.includes(top.skill_id);
        if (ambiguousHit) ambiguousDeliveredHits++;
        deliveredDelta[cell] =
          deliveredDelta[cell]! + Number(matchedHit) - Number(ambiguousHit);
      }
    }

    // A suffix sum turns the score/margin sweep into O(1) metric lookups:
    // a case auto-matches at every threshold pair at or below its point.
    for (let scoreIndex = scoreBreakpoints.length - 1; scoreIndex >= 0; scoreIndex--) {
      for (let marginIndex = width - 1; marginIndex >= 0; marginIndex--) {
        const cell = scoreIndex * width + marginIndex;
        if (scoreIndex + 1 < scoreBreakpoints.length) {
          const below = (scoreIndex + 1) * width + marginIndex;
          autoMatches[cell] = autoMatches[cell]! + autoMatches[below]!;
          correctMatches[cell] = correctMatches[cell]! + correctMatches[below]!;
          deliveredDelta[cell] = deliveredDelta[cell]! + deliveredDelta[below]!;
        }
        if (marginIndex + 1 < width) {
          const right = cell + 1;
          autoMatches[cell] = autoMatches[cell]! + autoMatches[right]!;
          correctMatches[cell] = correctMatches[cell]! + correctMatches[right]!;
          deliveredDelta[cell] = deliveredDelta[cell]! + deliveredDelta[right]!;
        }
        if (scoreIndex + 1 < scoreBreakpoints.length && marginIndex + 1 < width) {
          const diagonal = (scoreIndex + 1) * width + marginIndex + 1;
          autoMatches[cell] = autoMatches[cell]! - autoMatches[diagonal]!;
          correctMatches[cell] = correctMatches[cell]! - correctMatches[diagonal]!;
          deliveredDelta[cell] = deliveredDelta[cell]! - deliveredDelta[diagonal]!;
        }
      }
    }

    for (let scoreIndex = 0; scoreIndex < scoreBreakpoints.length; scoreIndex++) {
      const score = scoreBreakpoints[scoreIndex]!;
      if (score < floor) continue;
      for (let marginIndex = 0; marginIndex < marginBreakpoints.length; marginIndex++) {
        const margin = marginBreakpoints[marginIndex]!;
        const cell = scoreIndex * width + marginIndex;
        const autoMatchCount = autoMatches[cell]!;
        const correctAutoMatchCount = correctMatches[cell]!;
        const deliveredHits = ambiguousDeliveredHits + deliveredDelta[cell]!;
        const thresholds = {
          match_score: score,
          match_margin: margin,
          candidate_floor: floor,
        };
        const metrics: CalibrationMetrics = {
          auto_match_precision:
            autoMatchCount === 0 ? 0 : correctAutoMatchCount / autoMatchCount,
          auto_match_precision_lower_bound:
            wilsonLowerBound(correctAutoMatchCount, autoMatchCount),
          auto_match_coverage:
            expectedMatchCount === 0 ? 0 : correctAutoMatchCount / expectedMatchCount,
          auto_match_count: autoMatchCount,
          correct_auto_match_count: correctAutoMatchCount,
          retrieval_recall_at_k: retrievalRecall,
          delivered_shortlist_recall_at_k:
            matchable.length === 0 ? 1 : deliveredHits / matchable.length,
        };
        sawCoverage ||= metrics.auto_match_coverage > 0;
        sawSample ||= metrics.auto_match_count >= gates.minAutoMatchCount;
        sawPrecision ||= (
          metrics.auto_match_precision_lower_bound >= gates.minAutoMatchPrecision
        );
        if (!metricsPass(metrics, gates)) continue;
        const candidate = { thresholds, metrics };
        if (betterPolicy(candidate, best)) best = candidate;
      }
    }
  };

  // Coarse-to-fine floor search. Floor candidates come from non-top scores, so
  // this tunes shortlist trimming instead of merely suppressing top matches.
  const coarse = sampledFloorIndexes(floorBreakpoints.length);
  for (const index of coarse) evaluateFloor(index);
  if (best && coarse.length < floorBreakpoints.length) {
    const bestIndex = floorBreakpoints.indexOf(best.thresholds.candidate_floor);
    const radius = Math.ceil(floorBreakpoints.length / coarse.length);
    for (
      let index = Math.max(0, bestIndex - radius);
      index <= Math.min(floorBreakpoints.length - 1, bestIndex + radius);
      index++
    ) {
      if (!coarse.includes(index)) evaluateFloor(index);
    }
  }

  if (best) return { selected: best.thresholds };
  if (!sawCoverage) return { reason: "no_coverage" };
  if (!sawSample) return { reason: "insufficient_sample" };
  if (!sawPrecision) return { reason: "precision_floor_unreachable" };
  return { reason: "precision_floor_unreachable" };
}

// ---------------------------------------------------------------------------
// Public API — runCalibration (AC2, AC3, AC4)
// ---------------------------------------------------------------------------

async function processWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  processItem: (item: T) => Promise<void>,
): Promise<void> {
  let nextItemPosition = 0;
  let firstError: unknown;

  const claimNextPosition = (): number | undefined => {
    if (firstError !== undefined || nextItemPosition >= items.length) return undefined;
    return nextItemPosition++;
  };

  const workerCount = Math.min(concurrency, items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    for (
      let itemPosition = claimNextPosition();
      itemPosition !== undefined;
      itemPosition = claimNextPosition()
    ) {
      try {
        await processItem(items[itemPosition]!);
      } catch (error) {
        firstError ??= error;
      }
    }
  });

  // Drain work already in flight before propagating an error. Callers may close
  // resources after rejection, so no worker may still be checkpointing then.
  await Promise.all(workers);
  if (firstError !== undefined) throw firstError;
}

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
    getRankedCandidates,
    reranker,
    minAutoMatchPrecision = 0.75,
    minRetrievalRecallAtK = 0.95,
    minDeliveredShortlistRecallAtK = minRetrievalRecallAtK,
    minAutoMatchCount = 15,
    candidateLimit,
    concurrency = 4,
    initialObservations,
    onProgress,
    onObservation,
  } = opts;

  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error("concurrency must be a positive integer");
  }

  if (!getRankedCandidates && (!getCandidates || !reranker)) {
    throw new Error(
      "A configured reranker is required to run calibration. " +
        "Configure inference.reranker in your TOML config.",
    );
  }

  // --- Step 1: Cache observations (reranker called exactly once per query) ---
  const obsMap = new Map<number, QueryObservation>();
  if (initialObservations) {
    if (Array.isArray(initialObservations)) {
      initialObservations.forEach((obs, idx) => {
        if (obs) obsMap.set(idx, obs);
      });
    } else {
      for (const [idx, obs] of initialObservations.entries()) {
        obsMap.set(idx, obs);
      }
    }
  }

  let completedCount = obsMap.size;
  if (onProgress && completedCount > 0) {
    onProgress(completedCount, cases.length);
  }

  const pendingIndices: number[] = [];
  for (let i = 0; i < cases.length; i++) {
    if (!obsMap.has(i)) pendingIndices.push(i);
  }

  await processWithConcurrency(pendingIndices, concurrency, async (caseIndex) => {
    const c = cases[caseIndex]!;
    let ranked: Array<{ skill_id: string; score: number }>;
    if (getRankedCandidates) {
      ranked = await getRankedCandidates(c.query);
    } else {
      const docs = await getCandidates!(c.query);
      const scores = await reranker!(c.query, docs);
      ranked = docs
        .map((d, i) => ({ skill_id: d.skill_id, score: scores[i] ?? 0 }))
        .sort((a, b) => b.score - a.score);
    }
    const obs: QueryObservation = {
      query: c.query,
      split: c.split,
      expected_outcome: c.expected_outcome,
      relevant_skill_ids: c.relevant_skill_ids,
      ranked,
    };
    obsMap.set(caseIndex, obs);
    if (onObservation) {
      await onObservation(obs, caseIndex, completedCount + 1, cases.length);
    }
    const progressCount = ++completedCount;
    if (onProgress) {
      onProgress(progressCount, cases.length);
    }
  });

  const observations: QueryObservation[] = cases.map((_, i) => obsMap.get(i)!);
  opts.onObservationsReady?.();

  // --- Step 2: Select thresholds from tune split only ---
  const tuneObs = observations.filter((o) => o.split === "tune");
  const testObs = observations.filter((o) => o.split === "test");
  const retrievalThresholds = {
    match_score: 0,
    match_margin: 0,
    candidate_floor: 0,
  };
  const tuneRetrieval = computeMetrics(tuneObs, retrievalThresholds, candidateLimit);
  const testRetrieval = computeMetrics(testObs, retrievalThresholds, candidateLimit);
  if (
    tuneRetrieval.retrieval_recall_at_k < minRetrievalRecallAtK ||
    testRetrieval.retrieval_recall_at_k < minRetrievalRecallAtK
  ) {
    return {
      status: "failed_gates",
      failed_reason: "recall_precondition_failed",
      observations,
    };
  }

  const gates = {
    minAutoMatchPrecision,
    minRetrievalRecallAtK,
    minDeliveredShortlistRecallAtK,
    minAutoMatchCount,
  };
  const selection = selectThresholds(
    tuneObs,
    gates,
    candidateLimit,
  );

  if (!selection.selected) {
    return {
      status: "failed_gates",
      failed_reason: selection.reason,
      observations,
    };
  }
  const selected = selection.selected;

  // --- Step 3: Report tune metrics ---
  const tune_metrics = computeMetrics(tuneObs, selected, candidateLimit);

  // --- Step 4: Evaluate untouched test split ---
  const test_metrics = computeTestMetrics(testObs, selected, candidateLimit);
  if (!metricsPass(test_metrics, gates)) {
    return {
      status: "failed_gates",
      failed_reason: "test_certification_failed",
      observations,
      selected_thresholds: selected,
      tune_metrics,
      test_metrics,
    };
  }

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
  recall_settings?: {
    k_lexical: number;
    k_vector: number;
    k_rerank: number;
  };
  dataset_provenance?: DatasetProvenanceSummary;
  candidate_limit: number;
  attempt_count?: number;
  min_auto_match_precision: number;
  min_auto_match_count?: number;
  min_delivered_shortlist_recall_at_k?: number;
  min_shortlist_recall_at_5: number;
  failed_reason?: CalibrationFailureReason;
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
  human_labelled_case_count: number;
  imported_labelled_case_count: number;
  candidate_limit: number;
  attempt_count: number;
  min_auto_match_precision: number;
  min_auto_match_count: number;
  min_delivered_shortlist_recall_at_k: number;
  min_shortlist_recall_at_5: number;
  failed_reason?: CalibrationFailureReason;
}

/**
 * Fingerprint the indexed vault content so calibration runs can detect
 * corpus drift. Must match how `insertCalibrationRun` computes it at
 * `calibrate run` time.
 */
export function computeCorpusFingerprint(indexDb: Database): string {
  const indexedSkills = indexDb
    .query("SELECT skill_id, content_sha256 FROM skills ORDER BY skill_id")
    .all() as Array<{ skill_id: string; content_sha256: string }>;
  return "vault:" + createHash("sha256").update(JSON.stringify(indexedSkills)).digest("hex");
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

  const tableDef = db
    .query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'calibration_runs'")
    .get() as { sql: string } | null;

  if (
    tableDef &&
    tableDef.sql &&
    tableDef.sql.includes("CHECK") &&
    !tableDef.sql.includes("'running'")
  ) {
    const cols = db.query("PRAGMA table_info(calibration_runs)").all() as Array<{ name: string }>;
    const colNames = cols.map((c) => c.name);
    const selectCols = colNames.join(", ");

    db.transaction(() => {
      db.run(`CREATE TABLE calibration_runs_new (
        run_id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed_gates')),
        reranker_fingerprint TEXT NOT NULL,
        embedding_fingerprint TEXT NOT NULL,
        corpus_fingerprint TEXT NOT NULL,
        dataset_hash TEXT NOT NULL,
        min_auto_match_precision REAL NOT NULL,
        min_shortlist_recall_at_5 REAL NOT NULL,
        selected_thresholds TEXT,
        tune_metrics TEXT,
        test_metrics TEXT,
        observations TEXT NOT NULL,
        candidate_limit INTEGER NOT NULL DEFAULT 5,
        attempt_count INTEGER NOT NULL DEFAULT 1,
        min_auto_match_count INTEGER NOT NULL DEFAULT 1,
        min_delivered_shortlist_recall_at_k REAL NOT NULL DEFAULT 0.95,
        failed_reason TEXT,
        dataset_provenance TEXT NOT NULL DEFAULT '{}',
        human_labelled_case_count INTEGER NOT NULL DEFAULT 0,
        imported_labelled_case_count INTEGER NOT NULL DEFAULT 0,
        recall_settings TEXT NOT NULL DEFAULT '{}'
      )`);
      db.run(
        `INSERT INTO calibration_runs_new (${selectCols}) SELECT ${selectCols} FROM calibration_runs`,
      );
      db.run("DROP TABLE calibration_runs");
      db.run("ALTER TABLE calibration_runs_new RENAME TO calibration_runs");
    })();
  }

  db.run(`CREATE TABLE IF NOT EXISTS calibration_runs (
    run_id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed_gates')),
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
  const columns = db.query("PRAGMA table_info(calibration_runs)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "candidate_limit")) {
    db.run("ALTER TABLE calibration_runs ADD COLUMN candidate_limit INTEGER NOT NULL DEFAULT 5");
  }
  if (!columns.some((column) => column.name === "attempt_count")) {
    db.run("ALTER TABLE calibration_runs ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 1");
  }
  if (!columns.some((column) => column.name === "min_auto_match_count")) {
    db.run("ALTER TABLE calibration_runs ADD COLUMN min_auto_match_count INTEGER NOT NULL DEFAULT 1");
  }
  if (!columns.some((column) => column.name === "min_delivered_shortlist_recall_at_k")) {
    db.run("ALTER TABLE calibration_runs ADD COLUMN min_delivered_shortlist_recall_at_k REAL NOT NULL DEFAULT 0.95");
  }
  if (!columns.some((column) => column.name === "failed_reason")) {
    db.run("ALTER TABLE calibration_runs ADD COLUMN failed_reason TEXT");
  }
  if (!columns.some((column) => column.name === "dataset_provenance")) {
    db.run("ALTER TABLE calibration_runs ADD COLUMN dataset_provenance TEXT NOT NULL DEFAULT '{}'");
  }
  if (!columns.some((column) => column.name === "human_labelled_case_count")) {
    db.run("ALTER TABLE calibration_runs ADD COLUMN human_labelled_case_count INTEGER NOT NULL DEFAULT 0");
  }
  if (!columns.some((column) => column.name === "imported_labelled_case_count")) {
    db.run("ALTER TABLE calibration_runs ADD COLUMN imported_labelled_case_count INTEGER NOT NULL DEFAULT 0");
  }
  if (!columns.some((column) => column.name === "recall_settings")) {
    db.run("ALTER TABLE calibration_runs ADD COLUMN recall_settings TEXT NOT NULL DEFAULT '{}'");
  }

  db.run(`CREATE TABLE IF NOT EXISTS calibration_observations (
    run_id TEXT NOT NULL,
    case_index INTEGER NOT NULL,
    query TEXT NOT NULL,
    split TEXT NOT NULL,
    expected_outcome TEXT NOT NULL,
    relevant_skill_ids TEXT NOT NULL,
    ranked TEXT NOT NULL,
    PRIMARY KEY (run_id, case_index),
    FOREIGN KEY (run_id) REFERENCES calibration_runs(run_id) ON DELETE CASCADE
  )`);

  return db;
}

export interface CreateInitialCalibrationRunOptions {
  run_id: string;
  created_at: string;
  status: "running";
  reranker_fingerprint: string;
  embedding_fingerprint: string;
  corpus_fingerprint: string;
  dataset_hash: string;
  candidate_limit: number;
  min_auto_match_precision: number;
  min_auto_match_count?: number;
  min_delivered_shortlist_recall_at_k?: number;
  min_shortlist_recall_at_5: number;
  dataset_provenance?: DatasetProvenanceSummary;
  recall_settings?: {
    k_lexical: number;
    k_vector: number;
    k_rerank: number;
  };
}

/** Create an initial calibration run record with 'running' status before inference starts. */
export function createInitialCalibrationRun(
  db: Database,
  run: CreateInitialCalibrationRunOptions,
): void {
  const attemptCount = (
    db.query("SELECT COUNT(*) AS count FROM calibration_runs WHERE dataset_hash = ?")
      .get(run.dataset_hash) as { count: number }
  ).count + 1;
  db.run(
    `INSERT INTO calibration_runs (
      run_id, created_at, status,
      reranker_fingerprint, embedding_fingerprint, corpus_fingerprint, dataset_hash,
      candidate_limit,
      attempt_count, min_auto_match_precision, min_auto_match_count,
      min_delivered_shortlist_recall_at_k, min_shortlist_recall_at_5, failed_reason,
      selected_thresholds, tune_metrics, test_metrics, observations,
      dataset_provenance, human_labelled_case_count, imported_labelled_case_count,
      recall_settings
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      run.run_id,
      run.created_at,
      run.status,
      run.reranker_fingerprint,
      run.embedding_fingerprint,
      run.corpus_fingerprint,
      run.dataset_hash,
      run.candidate_limit,
      attemptCount,
      run.min_auto_match_precision,
      run.min_auto_match_count ?? 1,
      run.min_delivered_shortlist_recall_at_k ?? run.min_shortlist_recall_at_5,
      run.min_shortlist_recall_at_5,
      null,
      null,
      null,
      null,
      "[]",
      JSON.stringify(run.dataset_provenance ?? {}),
      run.dataset_provenance?.human_labelled_case_count ?? 0,
      run.dataset_provenance?.imported_labelled_case_count ?? 0,
      JSON.stringify(run.recall_settings ?? {}),
    ],
  );
}

/** Save a single case observation incrementally. */
export function saveCalibrationObservation(
  db: Database,
  runId: string,
  caseIndex: number,
  observation: QueryObservation,
): void {
  db.run(
    `INSERT OR REPLACE INTO calibration_observations (
      run_id, case_index, query, split, expected_outcome, relevant_skill_ids, ranked
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      runId,
      caseIndex,
      observation.query,
      observation.split,
      observation.expected_outcome,
      JSON.stringify(observation.relevant_skill_ids),
      JSON.stringify(observation.ranked),
    ],
  );
}

/** Retrieve all completed observations for a run_id, keyed by case index. */
export function getCalibrationObservations(
  db: Database,
  runId: string,
): Map<number, QueryObservation> {
  const rows = db
    .query(
      `SELECT case_index, query, split, expected_outcome, relevant_skill_ids, ranked
       FROM calibration_observations WHERE run_id = ? ORDER BY case_index ASC`,
    )
    .all(runId) as Array<{
      case_index: number;
      query: string;
      split: DecisionSplit;
      expected_outcome: DecisionOutcome;
      relevant_skill_ids: string;
      ranked: string;
    }>;
  const map = new Map<number, QueryObservation>();
  for (const r of rows) {
    map.set(r.case_index, {
      query: r.query,
      split: r.split,
      expected_outcome: r.expected_outcome,
      relevant_skill_ids: JSON.parse(r.relevant_skill_ids) as string[],
      ranked: JSON.parse(r.ranked) as Array<{ skill_id: string; score: number }>,
    });
  }
  return map;
}

export interface FinalizeCalibrationRunOptions {
  run_id: string;
  status: CalibrationStatus;
  failed_reason?: CalibrationFailureReason;
  selected_thresholds?: SelectedThresholds;
  tune_metrics?: CalibrationMetrics;
  test_metrics?: CalibrationTestMetrics;
  observations: QueryObservation[];
}

/** Finalize a calibration run record with its completion/failure status, metrics, and thresholds. */
export function finalizeCalibrationRun(
  db: Database,
  run: FinalizeCalibrationRunOptions,
): void {
  db.run(
    `UPDATE calibration_runs SET
      status = ?,
      failed_reason = ?,
      selected_thresholds = ?,
      tune_metrics = ?,
      test_metrics = ?,
      observations = ?
     WHERE run_id = ?`,
    [
      run.status,
      run.failed_reason ?? null,
      run.selected_thresholds != null ? JSON.stringify(run.selected_thresholds) : null,
      run.tune_metrics != null ? JSON.stringify(run.tune_metrics) : null,
      run.test_metrics != null ? JSON.stringify(run.test_metrics) : null,
      JSON.stringify(run.observations),
      run.run_id,
    ],
  );
}

/** Persist a calibration run (all fields) to the evidence store. */
export function insertCalibrationRun(db: Database, run: CalibrationRunRecord): void {
  const attemptCount = (
    db.query("SELECT COUNT(*) AS count FROM calibration_runs WHERE dataset_hash = ?")
      .get(run.dataset_hash) as { count: number }
  ).count + 1;
  db.transaction(() => {
    db.run(
      `INSERT OR REPLACE INTO calibration_runs (
        run_id, created_at, status,
        reranker_fingerprint, embedding_fingerprint, corpus_fingerprint, dataset_hash,
        candidate_limit,
        attempt_count, min_auto_match_precision, min_auto_match_count,
        min_delivered_shortlist_recall_at_k, min_shortlist_recall_at_5, failed_reason,
        selected_thresholds, tune_metrics, test_metrics, observations,
        dataset_provenance, human_labelled_case_count, imported_labelled_case_count,
        recall_settings
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        run.run_id,
        run.created_at,
        run.status,
        run.reranker_fingerprint,
        run.embedding_fingerprint,
        run.corpus_fingerprint,
        run.dataset_hash,
        run.candidate_limit,
        attemptCount,
        run.min_auto_match_precision,
        run.min_auto_match_count ?? 1,
        run.min_delivered_shortlist_recall_at_k ?? run.min_shortlist_recall_at_5,
        run.min_shortlist_recall_at_5,
        run.failed_reason ?? null,
        run.selected_thresholds != null ? JSON.stringify(run.selected_thresholds) : null,
        run.tune_metrics != null ? JSON.stringify(run.tune_metrics) : null,
        run.test_metrics != null ? JSON.stringify(run.test_metrics) : null,
        JSON.stringify(run.observations),
        JSON.stringify(run.dataset_provenance ?? {}),
        run.dataset_provenance?.human_labelled_case_count ?? 0,
        run.dataset_provenance?.imported_labelled_case_count ?? 0,
        JSON.stringify(run.recall_settings ?? {}),
      ],
    );
    if (run.observations && run.observations.length > 0) {
      for (let i = 0; i < run.observations.length; i++) {
        const obs = run.observations[i]!;
        saveCalibrationObservation(db, run.run_id, i, obs);
      }
    }
  })();
}

interface RawCalibrationRow {
  run_id: string;
  created_at: string;
  status: string;
  reranker_fingerprint: string;
  embedding_fingerprint: string;
  corpus_fingerprint: string;
  dataset_hash: string;
  candidate_limit: number;
  attempt_count: number;
  min_auto_match_precision: number;
  min_auto_match_count: number;
  min_delivered_shortlist_recall_at_k: number;
  min_shortlist_recall_at_5: number;
  failed_reason: string | null;
  selected_thresholds: string | null;
  tune_metrics: string | null;
  test_metrics: string | null;
  observations: string;
  dataset_provenance: string;
  human_labelled_case_count: number;
  imported_labelled_case_count: number;
  recall_settings: string;
}

function parseMetrics(json: string): CalibrationMetrics {
  const parsed = JSON.parse(json) as Partial<CalibrationMetrics> & {
    shortlist_recall_at_5?: number;
    false_no_match_rate?: number;
  };
  if (parsed.retrieval_recall_at_k === undefined) {
    parsed.retrieval_recall_at_k = parsed.shortlist_recall_at_5 ?? 0;
  }
  delete parsed.shortlist_recall_at_5;
  delete parsed.false_no_match_rate;
  return {
    auto_match_precision: parsed.auto_match_precision ?? 0,
    auto_match_precision_lower_bound:
      parsed.auto_match_precision_lower_bound ?? parsed.auto_match_precision ?? 0,
    auto_match_coverage: parsed.auto_match_coverage ?? 0,
    auto_match_count: parsed.auto_match_count ?? 0,
    correct_auto_match_count: parsed.correct_auto_match_count ?? 0,
    retrieval_recall_at_k: parsed.retrieval_recall_at_k,
    delivered_shortlist_recall_at_k:
      parsed.delivered_shortlist_recall_at_k ?? parsed.retrieval_recall_at_k,
  };
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
    recall_settings:
      Object.keys(JSON.parse(row.recall_settings) as object).length > 0
        ? JSON.parse(row.recall_settings) as CalibrationRunRecord["recall_settings"]
        : undefined,
    dataset_provenance:
      Object.keys(JSON.parse(row.dataset_provenance) as object).length > 0
        ? JSON.parse(row.dataset_provenance) as DatasetProvenanceSummary
        : undefined,
    candidate_limit: row.candidate_limit,
    attempt_count: row.attempt_count,
    min_auto_match_precision: row.min_auto_match_precision,
    min_auto_match_count: row.min_auto_match_count,
    min_delivered_shortlist_recall_at_k: row.min_delivered_shortlist_recall_at_k,
    min_shortlist_recall_at_5: row.min_shortlist_recall_at_5,
    failed_reason: row.failed_reason as CalibrationFailureReason | null ?? undefined,
    selected_thresholds: row.selected_thresholds != null
      ? (JSON.parse(row.selected_thresholds) as SelectedThresholds)
      : undefined,
    tune_metrics: row.tune_metrics != null
      ? parseMetrics(row.tune_metrics)
      : undefined,
    test_metrics: row.test_metrics != null
      ? {
          ...parseMetrics(row.test_metrics),
          confusion_matrix: (JSON.parse(row.test_metrics) as CalibrationTestMetrics).confusion_matrix,
        }
      : undefined,
    observations: JSON.parse(row.observations) as QueryObservation[],
  };
}

/** Retrieve a full run record by run_id. Returns null if not found. */
export function getCalibrationRun(db: Database, runId: string): CalibrationRunRecord | null {
  const row = db
    .query("SELECT * FROM calibration_runs WHERE run_id = ?")
    .get(runId) as RawCalibrationRow | null;
  if (!row) return null;
  const record = rowToRecord(row);
  if (record.observations.length === 0) {
    const obsMap = getCalibrationObservations(db, runId);
    if (obsMap.size > 0) {
      const sortedIndices = Array.from(obsMap.keys()).sort((a, b) => a - b);
      record.observations = sortedIndices.map((idx) => obsMap.get(idx)!);
    }
  }
  return record;
}

/** List all runs ordered by created_at descending (excludes observations blob). */
export function listCalibrationRuns(db: Database): CalibrationRunSummary[] {
  return db
    .query(
      `SELECT run_id, created_at, status,
        reranker_fingerprint, embedding_fingerprint, corpus_fingerprint, dataset_hash,
        candidate_limit,
        attempt_count, min_auto_match_precision, min_auto_match_count,
        min_delivered_shortlist_recall_at_k, min_shortlist_recall_at_5, failed_reason,
        human_labelled_case_count, imported_labelled_case_count
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
  if (
    !run.test_metrics ||
    !metricsPass(run.test_metrics, {
      minAutoMatchPrecision: run.min_auto_match_precision,
      minRetrievalRecallAtK: run.min_shortlist_recall_at_5,
      minDeliveredShortlistRecallAtK:
        run.min_delivered_shortlist_recall_at_k ?? run.min_shortlist_recall_at_5,
      minAutoMatchCount: run.min_auto_match_count ?? 1,
    })
  ) {
    throw new ApplyCalibrationError(
      `Calibration run "${runId}" is not certified on its frozen test split`,
      "test_certification_failed",
    );
  }

  // --- Gate 3: fingerprint staleness ---
  if (
    "currentRerankerFingerprint" in opts &&
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

  const { patchTomlFile } = await import("./config-mutation");
  await patchTomlFile(tomlPath, {
    matchScore: match_score,
    matchMargin: match_margin,
    candidateFloor: candidate_floor,
    runId,
  });
}
