import type { Database } from "bun:sqlite";
import { watch } from "node:fs";
import { join } from "node:path";
import { buildAuditRow } from "./audit";
import { expandHome, loadConfig } from "./config";
import {
  deleteSkill,
  ftsSearch,
  getSkillRow,
  ingestVault,
  insertAudit,
  openIndex,
  replaceSkills,
  skillCount,
  skillsNeedingVectors,
  toSkillRow,
  upsertSkill,
  upsertVector,
  vectorTopK,
} from "./db";
import type { SkillRow } from "./db";
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
import {
  decodeUtf8Strict,
  listSupportingFiles,
  parseSkillMd,
  readSkill,
  scanVault,
  sha256Hex,
  SKILL_ID_PATTERN,
} from "./vault";

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

/** Replace config/client overrides wholesale (tests, ops). Resets the cached index handle. */
export function configure(opts: Overrides): void {
  overrides = opts;
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

/** Runtime accessor for the eval harness and CLI — not part of the MCP surface. */
export async function getRuntime(): Promise<{ config: Config; db: Database; clients: Clients }> {
  const { config, db } = await getEnv();
  return { config, db, clients: getClients() };
}

/**
 * Zero-loss delivery (AC2): read SKILL.md from disk NOW, hash it, and if the
 * index is stale re-index that skill — never serve stale bytes.
 */
async function deliverSkill(db: Database, config: Config, skillId: string): Promise<FetchSkillResult> {
  const vaultPath = expandHome(config.vault_path);
  const file = Bun.file(join(vaultPath, skillId, "SKILL.md"));
  if (!(await file.exists())) {
    // Deleted on disk but the watcher hasn't caught up: drop the stale row and
    // surface the schema's error code rather than a raw ENOENT.
    deleteSkill(db, skillId);
    throw new Error(`SKILL_NOT_FOUND: skill '${skillId}' no longer exists in the vault`);
  }
  const bytes = await file.bytes();
  const contentSha256 = sha256Hex(bytes);
  const raw = decodeUtf8Strict(bytes);
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

const rerankText = (r: SkillRow) => `${r.title}\n${r.description}\n${r.aliases}`;

export interface RebuildReport {
  indexed: number;
  retained: string[];
}

/**
 * Full from-scratch rebuild of the lexical index (AC8). Skills whose SKILL.md
 * fails to parse keep their previously indexed row (`retained`) so a bad write
 * never evicts a working skill. Vectors persist by content hash; changed
 * content is re-embedded by the next backfill.
 */
export async function rebuildIndex(
  onInvalid?: (skillId: string, error: unknown) => void,
): Promise<RebuildReport> {
  const { config, db } = await getEnv();
  const invalidIds: string[] = [];
  const skills = await scanVault(expandHome(config.vault_path), (skillId, error) => {
    invalidIds.push(skillId);
    onInvalid?.(skillId, error);
  });
  const rows = skills.map(toSkillRow);
  const retained: string[] = [];
  for (const skillId of invalidIds) {
    const previous = getSkillRow(db, skillId);
    if (previous) {
      rows.push(previous);
      retained.push(skillId);
    }
  }
  replaceSkills(db, rows);
  return { indexed: rows.length, retained };
}

/**
 * Embed every skill missing a current vector (new or content changed).
 * Called by `skill-router index` and at server startup; failure is tolerated —
 * resolve falls back to lexical-only recall until vectors exist (AC8).
 */
export async function backfillEmbeddings(): Promise<number> {
  const { config, db } = await getEnv();
  const clients = getClients();
  const pending = skillsNeedingVectors(db, config.embedding.dimension);
  if (pending.length === 0) return 0;

  const BATCH_SIZE = 10;
  let count = 0;
  for (let i = 0; i < pending.length; i += BATCH_SIZE) {
    const chunk = pending.slice(i, i + BATCH_SIZE);
    try {
      const vectors = await clients.embed(chunk.map(rerankText));
      chunk.forEach((row, j) => {
        upsertVector(db, row.skill_id, row.content_sha256, vectors[j]!);
      });
      count += chunk.length;
    } catch (err) {
      if (i === 0) throw err;
      break;
    }
  }
  return count;
}

const WATCH_DEBOUNCE_MS = 300;
const STABLE_STAT_INTERVAL_MS = 100;
const STABLE_STAT_MAX_TRIES = 10;

/** Wait until SKILL.md stops changing (two identical stats in a row) or give up. */
async function waitForStableFile(path: string): Promise<void> {
  let previous = "";
  for (let i = 0; i < STABLE_STAT_MAX_TRIES; i++) {
    const file = Bun.file(path);
    if (!(await file.exists())) return;
    const current = `${file.size}:${file.lastModified}`;
    if (current === previous) return;
    previous = current;
    await Bun.sleep(STABLE_STAT_INTERVAL_MS);
  }
}

async function reindexOneSkill(db: Database, vaultPath: string, skillId: string): Promise<void> {
  const skillMd = join(vaultPath, skillId, "SKILL.md");
  await waitForStableFile(skillMd);
  if (!(await Bun.file(skillMd).exists())) {
    deleteSkill(db, skillId);
    return;
  }
  try {
    upsertSkill(db, await readSkill(vaultPath, skillId));
    backfillEmbeddings().catch(() => {});
  } catch (error) {
    console.error(`warning: keeping previous index entry for ${skillId}: ${error}`);
  }
}

/**
 * Watch the vault and fold file changes into the index within seconds (AC8).
 * Events are debounced per skill; a write that fails to parse keeps the
 * previous index entry. Returns a stop function.
 */
export async function startVaultWatcher(): Promise<() => void> {
  const { config, db } = await getEnv();
  const vaultPath = expandHome(config.vault_path);
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const watcher = watch(vaultPath, { recursive: true }, (_event, filename) => {
    const skillId = filename?.split(/[\\/]/)[0];
    if (!skillId || !SKILL_ID_PATTERN.test(skillId)) return;
    clearTimeout(timers.get(skillId));
    timers.set(
      skillId,
      setTimeout(() => {
        timers.delete(skillId);
        void reindexOneSkill(db, vaultPath, skillId);
      }, WATCH_DEBOUNCE_MS),
    );
  });
  // A watcher error (e.g. the vault root disappearing) must degrade the index,
  // not crash the server — an unhandled 'error' event would throw.
  watcher.on("error", (error) => {
    console.error(`warning: vault watcher error, live updates paused: ${error}`);
  });

  return () => {
    watcher.close();
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  };
}

export async function resolveSkill(input: ResolveSkillInput): Promise<ResolveResult> {
  const t0 = performance.now();
  const { config, db } = await getEnv();
  const clients = getClients();

  const lexical = ftsSearch(db, input.query, config.recall.k_lexical);

  // Hybrid recall (AC6): FTS5 top-k ∪ cosine top-k, deduped, lexical first.
  // Any remote failure — embed or rerank — flips the whole call to the
  // degraded lexical-only lane (AC7); vector-only rows are dropped because
  // without scores they are indistinguishable from noise.
  let degraded = input.forceDegraded === true;
  let rows = lexical;
  if (!degraded) {
    try {
      const queryVec = (await clients.embed([input.query]))[0]!;
      const seen = new Set(lexical.map((r) => r.skill_id));
      const nearest = vectorTopK(db, queryVec, config.recall.k_vector).filter((r) => !seen.has(r.skill_id));
      rows = [...lexical, ...nearest];
    } catch {
      degraded = true;
    }
  }

  let scores: number[] | null = null;
  if (!degraded && rows.length > 0) {
    try {
      scores = await clients.rerank(
        input.query,
        rows.map((r) => ({ skill_id: r.skill_id, text: rerankText(r) })),
      );
    } catch {
      degraded = true;
    }
  }
  if (degraded) rows = lexical;

  // Best first (schema AuditRow.candidates); degraded keeps BM25 recall order.
  const candidates: Candidate[] = rows
    .map((r, i) => ({
      skill_id: r.skill_id,
      title: r.title,
      description: r.description,
      rerank_score: degraded || scores === null ? null : (scores[i] ?? null),
    }))
    .sort((a, b) => (b.rerank_score ?? -Infinity) - (a.rerank_score ?? -Infinity));

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
