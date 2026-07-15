import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evalVault } from "../src/eval";
import { configure } from "../src/router-core";
import type { Config } from "../src/types";

// AC11: holdout phrases from descriptions → recall@5 lexical vs hybrid +
// suggested thresholds from the observed rerank score distribution.
// Rerank mock: token-overlap ratio, so the right skill reliably scores high.
const tmp = mkdtempSync(join(tmpdir(), "skill-router-eval-"));
const vaultDir = join(tmp, "vault");

function writeSkill(id: string, description: string) {
  const dir = join(vaultDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${id}\ndescription: ${description}\n---\n\n# ${id}\n\nBody of ${id}.\n`,
  );
}

const tokens = (text: string) => new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));

function overlap(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return ta.size === 0 ? 0 : shared / ta.size;
}

const config: Config = {
  vault_path: vaultDir,
  state_dir: join(tmp, "state"),
  recall: { k_lexical: 15, k_vector: 15 },
  thresholds: { match_score: 0.9, match_margin: 0.2, candidate_floor: 0.4 },
  embedding: {
    base_url: "http://127.0.0.1:9",
    api_key_env: "SKILL_ROUTER_EMBED_KEY",
    model: "microsoft/harrier-oss-v1-0.6b",
    dimension: 4,
  },
  rerank: { base_url: "http://127.0.0.1:9", model: "BAAI/bge-reranker-v2-m3" },
  remote_timeout_ms: 2000,
};

beforeAll(() => {
  writeSkill("csv-wrangler", "Reads huge CSV files; converts spreadsheets between formats.");
  writeSkill("deploy-helper", "Deploys container stacks to remote hosts; rolls back failed releases.");
  writeSkill("prose-editor", "Rewrites awkward prose for clarity; tightens rambling paragraphs.");

  configure({
    config,
    clients: {
      embed: async (texts) =>
        texts.map((t) => {
          const set = tokens(t);
          return Float32Array.from([
            set.has("csv") || set.has("spreadsheets") ? 1 : 0,
            set.has("deploys") || set.has("container") ? 1 : 0,
            set.has("prose") || set.has("paragraphs") ? 1 : 0,
            0.1,
          ]);
        }),
      rerank: async (query, docs) => docs.map((d) => overlap(query, d.text)),
    },
  });
});

afterAll(() => {
  configure({});
  rmSync(tmp, { recursive: true, force: true });
});

describe("eval harness (AC11)", () => {
  test("reports recall@5 per lane and suggests thresholds from the score distribution", async () => {
    const report = await evalVault();

    expect(report.queries).toBeGreaterThan(0);
    expect(report.lexical_recall_at_5).toBeGreaterThan(0);
    expect(report.lexical_recall_at_5).toBeLessThanOrEqual(1);
    expect(report.hybrid_recall_at_5).toBeGreaterThan(0);
    expect(report.hybrid_recall_at_5).toBeLessThanOrEqual(1);
    const s = report.suggested_thresholds;
    expect(s.match_score).toBeGreaterThan(0);
    expect(s.match_score).toBeLessThanOrEqual(1);
    expect(s.match_margin).toBeGreaterThanOrEqual(0);
    expect(s.candidate_floor).toBeLessThanOrEqual(s.match_score);
  });
});
