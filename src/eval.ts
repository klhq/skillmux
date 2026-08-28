import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  backfillEmbeddings,
  getRuntime,
  retrieveAndRerank,
} from "./router-core";

export interface EvalCase {
  query: string;
  split?: string;
  relevant_skill_ids: string[];
}

export function parseEvalCases(raw: unknown): EvalCase[] {
  if (!Array.isArray(raw)) throw new Error("Eval cases file must contain a JSON array");
  const result: EvalCase[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (typeof item !== "object" || item === null) {
      throw new Error(`Eval case at index ${i} must be an object`);
    }
    if ("expected" in item) {
      throw new Error(
        `Legacy 'expected' field at case ${i} is no longer supported in eval datasets; use 'relevant_skill_ids' instead.`,
      );
    }
    if ("expected_outcome" in item) {
      throw new Error(
        `Legacy 'expected_outcome' field at case ${i} is no longer supported in eval datasets; remove it and provide 'relevant_skill_ids' instead.`,
      );
    }
    if (typeof (item as any).query !== "string" || (item as any).query.trim().length === 0) {
      throw new Error(`Eval case at index ${i} has invalid 'query': must be a non-empty string`);
    }
    if (
      !Array.isArray((item as any).relevant_skill_ids) ||
      (item as any).relevant_skill_ids.some((id: unknown) => typeof id !== "string")
    ) {
      throw new Error(`Eval case at index ${i} has invalid 'relevant_skill_ids': must be an array of strings`);
    }
    const relevantSkillIds = (item as any).relevant_skill_ids as string[];
    if (relevantSkillIds.some((id) => id.trim().length === 0)) {
      throw new Error(`Eval case at index ${i} has invalid 'relevant_skill_ids': IDs must be non-empty strings`);
    }
    if (new Set(relevantSkillIds).size !== relevantSkillIds.length) {
      throw new Error(`Eval case at index ${i} has invalid 'relevant_skill_ids': duplicate IDs are not allowed`);
    }
    if ("split" in item && (item as any).split !== undefined && typeof (item as any).split !== "string") {
      throw new Error(`Eval case at index ${i} has invalid 'split': must be a string if present`);
    }
    result.push({
      query: (item as any).query,
      ...((item as any).split !== undefined ? { split: (item as any).split } : {}),
      relevant_skill_ids: relevantSkillIds,
    });
  }
  return result;
}

/** AC17: dedup key for promoted cases. Collapses whitespace and case differences that are not meaningfully distinct queries. */
export function normalizeQuery(query: string): string {
  return query.trim().replace(/\s+/g, " ").toLowerCase();
}

export interface ObservedFetch {
  query: string;
  skill_id: string;
}

/** AC17: groups fetched skill ids by normalized query into observed-split eval cases. */
export function buildPromotedCases(fetches: ObservedFetch[]): EvalCase[] {
  const byQuery = new Map<string, { query: string; skillIds: string[]; seen: Set<string> }>();
  for (const fetch of fetches) {
    const key = normalizeQuery(fetch.query);
    if (!key) continue;
    let entry = byQuery.get(key);
    if (!entry) {
      entry = { query: fetch.query, skillIds: [], seen: new Set() };
      byQuery.set(key, entry);
    }
    if (!entry.seen.has(fetch.skill_id)) {
      entry.seen.add(fetch.skill_id);
      entry.skillIds.push(fetch.skill_id);
    }
  }
  return [...byQuery.values()].map((entry) => ({
    query: entry.query,
    split: "observed",
    relevant_skill_ids: entry.skillIds,
  }));
}

/** AC18: never rewrites a case whose normalized query already exists in the target file. */
export function excludeExistingCases(
  cases: EvalCase[],
  existing: EvalCase[],
): { cases: EvalCase[]; skipped: number } {
  const existingKeys = new Set(existing.map((c) => normalizeQuery(c.query)));
  const kept: EvalCase[] = [];
  let skipped = 0;
  for (const c of cases) {
    if (existingKeys.has(normalizeQuery(c.query))) {
      skipped++;
    } else {
      kept.push(c);
    }
  }
  return { cases: kept, skipped };
}

/**
 * AC17: joins fetches to the resolve that produced them for promotion. Only
 * correlated fetches (a known resolve_audit_id) carry a query to promote;
 * uncorrelated fetches have no resolve to join against and are excluded.
 */
export function queryPromotableFetches(db: Database, sinceIso: string): ObservedFetch[] {
  return db
    .query(
      `SELECT audit.query AS query, fetch.skill_id AS skill_id
       FROM fetch
       JOIN audit ON fetch.resolve_audit_id = audit.id
       WHERE fetch.ts >= ?
       ORDER BY fetch.ts ASC`,
    )
    .all(sinceIso) as ObservedFetch[];
}

export interface EvalMetrics {
  recall_at_5: number;
  recall_at_10: number;
  mrr: number;
  ndcg_at_10: number;
}

export interface CandidateEvalDetail {
  skill_id: string;
  lexical_rank: number | null;
  fused_rank: number | null;
  reranked_rank?: number | null;
}

export interface EvalCaseResult {
  query: string;
  relevant_skill_ids: string[];
  retrieval: string;
  degraded_from?: string | null;
  degradation_reason?: string | null;
  latency_ms: number;
  recall_settings: {
    k_lexical: number;
    k_vector: number;
    k_rerank: number;
  };
  candidates: CandidateEvalDetail[];
}

export interface EvalReport {
  queries: number;
  judged_queries: number;
  unjudged_queries: number;
  lexical: EvalMetrics;
  hybrid: EvalMetrics;
  cases?: EvalCaseResult[];
}

export function computeRankingMetrics(rankings: string[][], cases: EvalCase[]): EvalMetrics {
  const judgedIndices: number[] = [];
  for (let i = 0; i < cases.length; i++) {
    if (cases[i]!.relevant_skill_ids && cases[i]!.relevant_skill_ids.length > 0) {
      judgedIndices.push(i);
    }
  }

  if (judgedIndices.length === 0) {
    return {
      recall_at_5: 0,
      recall_at_10: 0,
      mrr: 0,
      ndcg_at_10: 0,
    };
  }

  let totalRecall5 = 0;
  let totalRecall10 = 0;
  let totalMRR = 0;
  let totalNDCG10 = 0;

  for (const idx of judgedIndices) {
    const c = cases[idx]!;
    const ranking = rankings[idx] ?? [];
    const relevantSet = new Set(c.relevant_skill_ids);
    const numRelevant = c.relevant_skill_ids.length;

    // Recall@5: fraction of relevant skill IDs present in the first 5 results
    const top5 = ranking.slice(0, 5);
    const count5 = top5.filter((id) => relevantSet.has(id)).length;
    totalRecall5 += count5 / numRelevant;

    // Recall@10: fraction of relevant skill IDs present in the first 10 results
    const top10 = ranking.slice(0, 10);
    const count10 = top10.filter((id) => relevantSet.has(id)).length;
    totalRecall10 += count10 / numRelevant;

    // MRR: reciprocal rank of the first relevant result (1-based), 0 if missing
    const firstRelevantRank = ranking.findIndex((id) => relevantSet.has(id));
    if (firstRelevantRank >= 0) {
      totalMRR += 1 / (firstRelevantRank + 1);
    }

    // nDCG@10: binary relevance, DCG gain 1/log2(rank+1), IDCG over min(numRelevant, 10)
    let dcg10 = 0;
    for (let r = 0; r < Math.min(10, ranking.length); r++) {
      if (relevantSet.has(ranking[r]!)) {
        dcg10 += 1 / Math.log2(r + 2);
      }
    }
    let idcg10 = 0;
    const idealCount = Math.min(numRelevant, 10);
    for (let r = 0; r < idealCount; r++) {
      idcg10 += 1 / Math.log2(r + 2);
    }
    if (idcg10 > 0) {
      totalNDCG10 += dcg10 / idcg10;
    }
  }

  const judgedCount = judgedIndices.length;
  return {
    recall_at_5: totalRecall5 / judgedCount,
    recall_at_10: totalRecall10 / judgedCount,
    mrr: totalMRR / judgedCount,
    ndcg_at_10: totalNDCG10 / judgedCount,
  };
}

export function loadEvalCases(path = join(import.meta.dir, "..", "eval", "queries.json")): EvalCase[] {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return parseEvalCases(raw);
}

export async function evalVault(cases = loadEvalCases()): Promise<EvalReport> {
  const { config } = await getRuntime();
  await backfillEmbeddings();

  const lexicalRankings: string[][] = [];
  const hybridRankings: string[][] = [];
  const caseResults: EvalCaseResult[] = [];
  const kRerank = config.recall.k_rerank ?? Math.min(10, config.recall.k_lexical + config.recall.k_vector);

  for (const evalCase of cases) {
    const start = performance.now();
    const retrievalResult = await retrieveAndRerank({ query: evalCase.query });

    // lexical metrics use lexical rank
    lexicalRankings.push(
      retrievalResult.trace
        .filter((candidate) => candidate.lexical_rank !== null)
        .sort((a, b) => a.lexical_rank! - b.lexical_rank!)
        .map((candidate) => candidate.skill_id),
    );

    // retrieveAndRerank returns candidates in the exact order delivered to the
    // caller: reranked when available, otherwise fused or lexical fallback.
    hybridRankings.push(
      retrievalResult.candidates.map((candidate) => candidate.skill_id),
    );

    const latency_ms = Math.round(performance.now() - start);
    const candidateDetails: CandidateEvalDetail[] = retrievalResult.trace;

    caseResults.push({
      query: evalCase.query,
      relevant_skill_ids: evalCase.relevant_skill_ids,
      retrieval: retrievalResult.retrieval,
      degraded_from: retrievalResult.degraded_from ?? null,
      degradation_reason: retrievalResult.degradation_reason ?? null,
      latency_ms,
      recall_settings: {
        k_lexical: config.recall.k_lexical,
        k_vector: config.recall.k_vector,
        k_rerank: kRerank,
      },
      candidates: candidateDetails,
    });
  }

  const judged_queries = cases.filter(
    (c) => c.relevant_skill_ids && c.relevant_skill_ids.length > 0,
  ).length;
  const unjudged_queries = cases.length - judged_queries;

  return {
    queries: cases.length,
    judged_queries,
    unjudged_queries,
    lexical: computeRankingMetrics(lexicalRankings, cases),
    hybrid: computeRankingMetrics(hybridRankings, cases),
    cases: caseResults,
  };
}
