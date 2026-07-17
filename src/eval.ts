import type { SkillRow } from "./db";
import { ftsSearch, vectorTopK } from "./db";
import { backfillEmbeddings, getRuntime } from "./router-core";

export interface SuggestedThresholds {
  match_score: number;
  match_margin: number;
  candidate_floor: number;
}

export interface EvalReport {
  queries: number;
  lexical_recall_at_5: number;
  hybrid_recall_at_5: number;
  suggested_thresholds: SuggestedThresholds;
}

/** Holdout queries: description clauses of ≥3 words, split on . and ; */
export function holdoutPhrases(description: string): string[] {
  return description
    .split(/[.;]/)
    .map((phrase) => phrase.trim())
    .filter((phrase) => phrase.split(/\s+/).length >= 3);
}

const mean = (xs: number[]) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)));
  return sorted[index]!;
}

/**
 * AC11: replay description-derived holdout phrases through both recall lanes,
 * report recall@5, and derive threshold suggestions from the observed rerank
 * score distribution (positives vs impostor tops).
 *
 * Optimised for remote endpoints:
 *  - embeds ALL query phrases in a single batched call
 *  - runs rerank calls with bounded concurrency (RERANK_CONCURRENCY)
 */
export async function evalVault(): Promise<EvalReport> {
  const { config, db, clients } = await getRuntime();
  if (!clients.rerank) throw new Error("Evaluation requires a configured reranker.");
  const rerank = clients.rerank;
  await backfillEmbeddings();

  const skills = db.query("SELECT * FROM skills").all() as SkillRow[];
  const cases = skills.flatMap((skill) =>
    holdoutPhrases(skill.description).map((query) => ({ query, expected: skill.skill_id })),
  );

  // 1. Lexical pass (pure SQLite — fast)
  let lexicalHits = 0;
  const lexicalCandidates: SkillRow[][] = [];
  for (const { query, expected } of cases) {
    const top5 = ftsSearch(db, query, 5);
    if (top5.some((r) => r.skill_id === expected)) lexicalHits++;
    lexicalCandidates.push(ftsSearch(db, query, config.recall.k_lexical));
  }

  // 2. Batch-embed all queries in chunks (16 at a time to stay within endpoint limits)
  const EMBED_CHUNK = 16;
  const queryTexts = cases.map((c) => c.query);
  const queryVecs: Float32Array[] = [];
  for (let i = 0; i < queryTexts.length; i += EMBED_CHUNK) {
    const chunk = queryTexts.slice(i, i + EMBED_CHUNK);
    const vecs = await clients.embed(chunk);
    queryVecs.push(...vecs);
  }

  // 3. Build per-query candidate pools (lexical ∪ vector)
  const candidatePools = cases.map((_, i) => {
    const lexical = lexicalCandidates[i]!;
    const seen = new Set(lexical.map((r) => r.skill_id));
    return [
      ...lexical,
      ...vectorTopK(db, queryVecs[i]!, config.recall.k_vector).filter((r) => !seen.has(r.skill_id)),
    ];
  });

  // 4. Rerank sequentially — Infinity is single-threaded; concurrency only causes queueing timeouts
  const CONCURRENCY = 1;
  const positiveTops: number[] = [];
  const positiveMargins: number[] = [];
  const positiveScores: number[] = [];
  const impostorTops: number[] = [];
  let hybridHits = 0;

  for (let base = 0; base < cases.length; base += CONCURRENCY) {
    const chunk = cases.slice(base, base + CONCURRENCY);
    const pools = candidatePools.slice(base, base + CONCURRENCY);

    const chunkScores = await Promise.all(
      chunk.map((c, j) => {
        const rows = pools[j]!;
        if (rows.length === 0) return Promise.resolve([] as number[]);
        return rerank(
          c.query,
          rows.map((r) => ({ skill_id: r.skill_id, text: `${r.title}\n${r.description}\n${r.aliases}` })),
        );
      }),
    );

    for (let j = 0; j < chunk.length; j++) {
      const { expected } = chunk[j]!;
      const rows = pools[j]!;
      const scores = chunkScores[j]!;
      if (rows.length === 0) continue;

      const ranked = rows
        .map((r, i) => ({ skill_id: r.skill_id, score: scores[i] ?? 0 }))
        .sort((a, b) => b.score - a.score);

      if (ranked.slice(0, 5).some((r) => r.skill_id === expected)) hybridHits++;

      const top = ranked[0]!;
      const expectedEntry = ranked.find((r) => r.skill_id === expected);
      if (expectedEntry) positiveScores.push(expectedEntry.score);
      if (top.skill_id === expected) {
        positiveTops.push(top.score);
        positiveMargins.push(ranked.length > 1 ? top.score - ranked[1]!.score : top.score);
      } else {
        impostorTops.push(top.score);
      }
    }
  }

  const meanPositive = positiveTops.length > 0 ? mean(positiveTops) : config.thresholds.match_score;
  const meanImpostor = impostorTops.length > 0 ? mean(impostorTops) : meanPositive / 2;
  const matchScore = Math.min(1, Math.max(0, (meanPositive + meanImpostor) / 2));

  return {
    queries: cases.length,
    lexical_recall_at_5: cases.length === 0 ? 0 : lexicalHits / cases.length,
    hybrid_recall_at_5: cases.length === 0 ? 0 : hybridHits / cases.length,
    suggested_thresholds: {
      match_score: matchScore,
      match_margin: percentile(positiveMargins, 25),
      candidate_floor: Math.min(percentile(positiveScores, 10), matchScore),
    },
  };
}
