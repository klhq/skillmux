import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  backfillEmbeddings,
  decideRetrievalResult,
  getRuntime,
  retrieveAndRerank,
} from "./router-core";

export interface EvalCase {
  query: string;
  expected: string[];
}

const rawEvalItemSchema = z.object({
  query: z.string().min(1),
  expected: z.array(z.string().min(1)).optional(),
  relevant_skill_ids: z.array(z.string()).optional(),
  split: z.string().optional(),
  expected_outcome: z.string().optional(),
});


export interface EvalMetrics {
  recall_at_3: number;
  recall_at_5: number;
  mrr: number;
}

export interface CandidateEvalDetail {
  skill_id: string;
  lexical_rank: number | null;
  fused_rank: number | null;
  reranked_rank?: number | null;
}

export interface EvalCaseResult {
  query: string;
  expected: string[];
  outcome: "matched" | "ambiguous" | "no_match";
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
  lexical: EvalMetrics;
  hybrid: EvalMetrics;
  cases?: EvalCaseResult[];
}

function metrics(rankings: string[][], cases: EvalCase[]): EvalMetrics {
  if (cases.length === 0) return { recall_at_3: 0, recall_at_5: 0, mrr: 0 };
  let recall3 = 0;
  let recall5 = 0;
  let reciprocalRanks = 0;
  rankings.forEach((ranking, index) => {
    const expected = new Set(cases[index]!.expected);
    if (ranking.slice(0, 3).some((id) => expected.has(id))) recall3++;
    if (ranking.slice(0, 5).some((id) => expected.has(id))) recall5++;
    const rank = ranking.findIndex((id) => expected.has(id));
    if (rank >= 0) reciprocalRanks += 1 / (rank + 1);
  });
  return {
    recall_at_3: recall3 / cases.length,
    recall_at_5: recall5 / cases.length,
    mrr: reciprocalRanks / cases.length,
  };
}

export function loadEvalCases(path = join(import.meta.dir, "..", "eval", "queries.json")): EvalCase[] {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(raw)) throw new Error("Eval cases file must contain a JSON array");
  const parsed = z.array(rawEvalItemSchema).parse(raw);
  const result: EvalCase[] = [];
  for (const item of parsed) {
    const expected = item.expected ?? item.relevant_skill_ids;
    if (expected && expected.length > 0) {
      result.push({ query: item.query, expected });
    }
  }
  if (parsed.length > 0 && result.length === 0) {
    throw new Error("Eval cases file contained no cases with expected targets");
  }
  return result;
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
    const decision = decideRetrievalResult(config, retrievalResult);
    const fusedRanking = retrievalResult.trace
      .filter((candidate) => candidate.fused_rank !== null)
      .sort((a, b) => a.fused_rank! - b.fused_rank!)
      .map((candidate) => candidate.skill_id);

    lexicalRankings.push(retrievalResult.trace
      .filter((candidate) => candidate.lexical_rank !== null)
      .sort((a, b) => a.lexical_rank! - b.lexical_rank!)
      .map((candidate) => candidate.skill_id));
    hybridRankings.push(fusedRanking.length > 0
      ? fusedRanking
      : retrievalResult.candidates.map((candidate) => candidate.skill_id));

    const latency_ms = Math.round(performance.now() - start);
    const candidateDetails: CandidateEvalDetail[] = retrievalResult.trace;

    caseResults.push({
      query: evalCase.query,
      expected: evalCase.expected,
      outcome: decision.outcome,
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

  return {
    queries: cases.length,
    lexical: metrics(lexicalRankings, cases),
    hybrid: metrics(hybridRankings, cases),
    cases: caseResults,
  };
}
