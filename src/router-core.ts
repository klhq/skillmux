import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { buildAuditRow } from "./audit";
import { expandHome, loadConfig } from "./config";
import { ftsSearch, getSkillRow, ingestVault, insertAudit, openIndex, skillCount, upsertSkill } from "./db";
import { decideResolveOutcome } from "./decision";
import type {
  Candidate,
  Clients,
  Config,
  FetchSkillInput,
  FetchSkillResult,
  ResolveResult,
  ResolveSkillInput,
} from "./types";
import { listSupportingFiles, parseSkillMd, scanVault, sha256Hex } from "./vault";

export { buildAuditRow } from "./audit";
export { loadConfig } from "./config";
export { decideResolveOutcome } from "./decision";
export type * from "./types";

const NO_MATCH_MESSAGE =
  "No skill in the vault passed the relevance threshold for this task. " +
  "Proceed under your normal workflow; do not load an unrelated skill.";

interface Overrides {
  config?: Config;
  clients?: Partial<Clients>;
}

// Remote clients default to failing fast, which routes resolveSkill into the
// degraded lane (AC7). Real HTTP clients arrive with their own tests (Task 4).
const defaultClients: Clients = {
  embed: async () => {
    throw new Error("embedding client not configured");
  },
  rerank: async () => {
    throw new Error("rerank client not configured");
  },
};

let overrides: Overrides = {};
let env: { config: Config; db: Database } | null = null;

/** Inject config/clients (tests, ops). Resets the cached index handle. */
export function configure(opts: Overrides): void {
  overrides = { ...overrides, ...opts };
  env = null;
}

async function getEnv(): Promise<{ config: Config; db: Database }> {
  if (env) return env;
  const config = overrides.config ?? (await loadConfig());
  const db = openIndex(expandHome(config.state_dir));
  if (skillCount(db) === 0) {
    ingestVault(db, await scanVault(expandHome(config.vault_path)));
  }
  env = { config, db };
  return env;
}

function getClients(): Clients {
  return { ...defaultClients, ...overrides.clients };
}

/**
 * Zero-loss delivery (AC2): read SKILL.md from disk NOW, hash it, and if the
 * index is stale re-index that skill — never serve stale bytes.
 */
async function deliverSkill(db: Database, config: Config, skillId: string): Promise<FetchSkillResult> {
  const vaultPath = expandHome(config.vault_path);
  const raw = await Bun.file(join(vaultPath, skillId, "SKILL.md")).text();
  const contentSha256 = sha256Hex(raw);
  let row = getSkillRow(db, skillId);
  if (row === null || row.content_sha256 !== contentSha256) {
    const fresh = parseSkillMd(skillId, raw);
    upsertSkill(db, fresh);
    row = getSkillRow(db, skillId)!;
  }
  return {
    skill_id: skillId,
    title: row.title,
    content_sha256: contentSha256,
    body: raw,
    files: listSupportingFiles(vaultPath, skillId),
  };
}

export async function resolveSkill(input: ResolveSkillInput): Promise<ResolveResult> {
  const t0 = performance.now();
  const { config, db } = await getEnv();
  const clients = getClients();

  const rows = ftsSearch(db, input.query, config.recall.k_lexical);

  let degraded = input.forceDegraded === true;
  let scores: number[] | null = null;
  if (!degraded && rows.length > 0) {
    try {
      scores = await clients.rerank(
        input.query,
        rows.map((r) => ({ skill_id: r.skill_id, text: `${r.title}\n${r.description}\n${r.aliases}` })),
      );
    } catch {
      degraded = true;
    }
  }

  const candidates: Candidate[] = rows.map((r, i) => ({
    skill_id: r.skill_id,
    title: r.title,
    description: r.description,
    rerank_score: degraded || scores === null ? null : (scores[i] ?? null),
  }));

  const decision = decideResolveOutcome({ degraded, candidates, thresholds: config.thresholds });

  let result: ResolveResult;
  if (decision.outcome === "matched") {
    const delivery = await deliverSkill(db, config, decision.skill_id);
    result = {
      outcome: "matched",
      degraded: false,
      skill_id: decision.skill_id,
      title: delivery.title,
      content_sha256: delivery.content_sha256,
      score: decision.score,
      margin: decision.margin,
      body: delivery.body,
      files: delivery.files,
    };
  } else if (decision.outcome === "ambiguous") {
    result = { outcome: "ambiguous", degraded, candidates: decision.candidates };
  } else {
    result = { outcome: "no_match", degraded, message: NO_MATCH_MESSAGE };
  }

  insertAudit(
    db,
    buildAuditRow({
      id: 0, // assigned by SQLite
      ts: new Date().toISOString(),
      query: input.query,
      outcome: result.outcome,
      degraded,
      candidates: candidates.map((c) => ({ skill_id: c.skill_id, score: c.rerank_score })),
      selected_skill_id: result.outcome === "matched" ? result.skill_id : null,
      latency_ms: Math.round(performance.now() - t0),
    }),
  );

  return result;
}

export async function fetchSkill(input: FetchSkillInput): Promise<FetchSkillResult> {
  const { config, db } = await getEnv();
  if (getSkillRow(db, input.skill_id) === null) {
    throw new Error(`SKILL_NOT_FOUND: no skill '${input.skill_id}' in the index`);
  }
  return deliverSkill(db, config, input.skill_id);
}
