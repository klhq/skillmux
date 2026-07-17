import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { SkillRow } from "./db";
import { ftsSearch, vectorTopK } from "./db";
import { reciprocalRankFusion } from "./rrf";
import { backfillEmbeddings, getRuntime } from "./router-core";

export interface EvalCase {
  query: string;
  expected: string[];
}

const evalCasesSchema = z.array(z.object({
  query: z.string().min(1),
  expected: z.array(z.string().min(1)).min(1),
}).strict());

export interface EvalMetrics {
  recall_at_3: number;
  recall_at_5: number;
  mrr: number;
}

export interface EvalReport {
  queries: number;
  lexical: EvalMetrics;
  hybrid: EvalMetrics;
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
  return evalCasesSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

export async function evalVault(cases = loadEvalCases()): Promise<EvalReport> {
  const { config, db, clients } = await getRuntime();
  if (config.inference.mode !== "local") throw new Error('Default evaluation requires inference.mode = "local".');
  await backfillEmbeddings();

  const lexicalRankings: string[][] = [];
  const hybridRankings: string[][] = [];
  for (const evalCase of cases) {
    const lexical = ftsSearch(db, evalCase.query, config.recall.k_lexical);
    const vector = (await clients.embed([evalCase.query]))[0]!;
    const semantic = vectorTopK(db, vector, config.recall.k_vector);
    lexicalRankings.push(lexical.map((row) => row.skill_id));
    hybridRankings.push(reciprocalRankFusion<SkillRow>(lexical, semantic).map((row) => row.skill_id));
  }

  return {
    queries: cases.length,
    lexical: metrics(lexicalRankings, cases),
    hybrid: metrics(hybridRankings, cases),
  };
}
