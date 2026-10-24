// Per-language ranking evaluation against the fixture vault in ./vault.
// Run: bun run eval/multilingual/run.ts
// Uses the embedding model from your skillmux config (default local gte-small).
// Cases use `split` as the language / scenario tag.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeRankingMetrics, loadEvalCases } from "../../src/eval";
import { loadConfig } from "../../src/config";
import { backfillEmbeddings, configure, retrieveAndRerank, syncVaultIfNeeded } from "../../src/router-core";
import { createClients } from "../../src/clients";

const here = import.meta.dir;
const tmp = mkdtempSync(join(tmpdir(), "skillmux-ml-eval-"));
const configPath = join(tmp, "skillmux.toml");
writeFileSync(configPath, `vault_path = "${join(here, "vault")}"\nstate_dir = "${join(tmp, "state")}"\n`);
process.env.SKILLMUX_CONFIG = configPath;

const config = await loadConfig();
configure({ config, clients: createClients(config) });
await syncVaultIfNeeded();
await backfillEmbeddings();

const cases = loadEvalCases(join(here, "queries.json"));
const lexical: string[][] = [];
const hybrid: string[][] = [];
for (const c of cases) {
  const r = await retrieveAndRerank({ query: c.query });
  lexical.push(r.trace.filter((t) => t.lexical_rank !== null).sort((a, b) => a.lexical_rank! - b.lexical_rank!).map((t) => t.skill_id));
  hybrid.push(r.candidates.map((x) => x.skill_id));
}

const row = (label: string, idx: number[]) => {
  const sub = idx.map((i) => cases[i]!);
  const l = computeRankingMetrics(idx.map((i) => lexical[i]!), sub);
  const h = computeRankingMetrics(idx.map((i) => hybrid[i]!), sub);
  const f = (n: number) => n.toFixed(2).padStart(5);
  console.log(`${label.padEnd(14)} ${String(sub.length).padStart(2)}  lex r@5 ${f(l.recall_at_5)} mrr ${f(l.mrr)}  |  hyb r@5 ${f(h.recall_at_5)} mrr ${f(h.mrr)}`);
};

const groups = new Map<string, number[]>();
cases.forEach((c, i) => {
  if (c.relevant_skill_ids.length === 0) return;
  groups.set(c.split ?? "all", [...(groups.get(c.split ?? "all") ?? []), i]);
});
console.log(`embedding model: ${config.inference.embedding?.model ?? "(none)"}`);
for (const [g, idx] of groups) row(g, idx);
row("ALL", [...groups.values()].flat());
