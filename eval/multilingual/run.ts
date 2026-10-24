// Per-language ranking evaluation against the fixture vault in ./vault.
// Run: bun run eval/multilingual/run.ts
// Default: local gte-small, no reranker. To measure a deployment, point at its config:
//   EVAL_CONFIG=~/.config/skillmux/config.toml bun run eval/multilingual/run.ts
// Only the vault and state directory are overridden; inference settings come from that file.
// EVAL_VAULT and EVAL_CASES swap in another vault and query file (for example a private one).
// Cases use `split` as the language / scenario tag.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeRankingMetrics, loadEvalCases } from "../../src/eval";
import { loadConfig } from "../../src/config";
import { backfillEmbeddings, configure, retrieveAndRerank, syncVaultIfNeeded } from "../../src/router-core";
import { createClients } from "../../src/clients";

const here = import.meta.dir;
const vaultDir = process.env.EVAL_VAULT?.replace(/^~/, process.env.HOME ?? "~") ?? join(here, "vault");
const tmp = mkdtempSync(join(tmpdir(), "skillmux-ml-eval-"));
const configPath = join(tmp, "skillmux.toml");
if (process.env.EVAL_CONFIG) {
  process.env.SKILLMUX_CONFIG = process.env.EVAL_CONFIG.replace(/^~/, process.env.HOME ?? "~");
  process.env.SKILLMUX_VAULT_PATH = vaultDir;
  process.env.SKILLMUX_STATE_DIR = join(tmp, "state");
} else {
  writeFileSync(configPath, `vault_path = "${vaultDir}"\nstate_dir = "${join(tmp, "state")}"\n`);
  process.env.SKILLMUX_CONFIG = configPath;
}

const config = await loadConfig();
configure({ config, clients: createClients(config) });
await syncVaultIfNeeded();
await backfillEmbeddings();

const cases = loadEvalCases(process.env.EVAL_CASES ?? join(here, "queries.json"));
const lexical: string[][] = [];
const hybrid: string[][] = [];
const modes = new Map<string, number>();
for (const c of cases) {
  const r = await retrieveAndRerank({ query: c.query });
  modes.set(r.retrieval, (modes.get(r.retrieval) ?? 0) + 1);
  lexical.push(r.trace.filter((t) => t.lexical_rank !== null).sort((a, b) => a.lexical_rank! - b.lexical_rank!).map((t) => t.skill_id));
  hybrid.push(r.candidates.map((x) => x.skill_id));
}

if (process.env.EVAL_VERBOSE) {
  cases.forEach((c, i) => {
    if (c.relevant_skill_ids.length === 0) return;
    const rank = hybrid[i]!.findIndex((id) => c.relevant_skill_ids.includes(id)) + 1;
    if (rank !== 1) console.log(`rank ${rank || "miss"}: ${c.query} -> want ${c.relevant_skill_ids.join("|")}, got ${hybrid[i]!.slice(0, 3).join(", ")}`);
  });
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
console.log(`reranker: ${config.inference.reranker?.model ?? "(none)"}`);
console.log(`retrieval modes: ${[...modes].map(([m, n]) => `${m}=${n}`).join(" ")}  (hyb column = final ranking of that mode)`);
for (const [g, idx] of groups) row(g, idx);
row("ALL", [...groups.values()].flat());
