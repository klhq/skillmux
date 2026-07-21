import type { Database } from "bun:sqlite";
import { watch } from "node:fs";
import { join } from "node:path";
import { buildAuditRow } from "./audit";
import { embeddingDimension, embeddingFingerprint, expandHome, loadConfig } from "./config";
import {
  deleteSkill,
  findExactMatch,
  ftsSearch,
  getIndexMeta,
  getSkillRow,
  ingestVault,
  insertAudit,
  openIndex,
  replaceSkills,
  setIndexMeta,
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
  RankedCandidate,
  RetrievalCapability,
  Clients,
  Config,
  FetchSkillInput,
  FetchSkillResult,
  ResolveResult,
  ResolveSkillInput,
} from "./types";
import { reciprocalRankFusion } from "./rrf";
import {
  decodeUtf8Strict,
  getVaultMaxMtime,
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
// Production clients are installed during server startup; tests can inject fakes.
const defaultClients: Clients = {
  embed: async () => {
    throw new Error("embedding client not configured");
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
    const vaultPath = expandHome(config.vault_path);
    ingestVault(db, await scanVault(vaultPath));
    setIndexMeta(db, "last_indexed_mtime", String(getVaultMaxMtime(vaultPath)));
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

export function closeRuntime(): void {
  env?.db.close();
  env = null;
}

/**
 * Zero-loss delivery: read SKILL.md from disk now, hash it, and if the
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
 * Full from-scratch rebuild of the lexical index. Skills whose SKILL.md
 * fails to parse keep their previously indexed row (`retained`) so a bad write
 * never evicts a working skill. Vectors persist by content hash; changed
 * content is re-embedded by the next backfill.
 */
export async function rebuildIndex(
  onInvalid?: (skillId: string, error: unknown) => void,
): Promise<RebuildReport> {
  const { config, db } = await getEnv();
  const vaultPath = expandHome(config.vault_path);
  const currentMtime = getVaultMaxMtime(vaultPath);
  const invalidIds: string[] = [];
  const skills = await scanVault(vaultPath, (skillId, error) => {
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
  setIndexMeta(db, "last_indexed_mtime", String(currentMtime));
  return { indexed: rows.length, retained };
}

/**
 * On-Demand Lazy Indexing (First Principles #2):
 * Checks the max mtime of the vault directory and re-indexes only if files have changed.
 * This runs synchronously to block queries until the lexical index is correct.
 */
export async function syncVaultIfNeeded(): Promise<void> {
  const { config, db } = await getEnv();
  const vaultPath = expandHome(config.vault_path);
  const currentMtime = getVaultMaxMtime(vaultPath);
  const lastIndexed = getIndexMeta(db, "last_indexed_mtime");

  if (lastIndexed === null || currentMtime > Number(lastIndexed)) {
    const invalidIds: string[] = [];
    const skills = await scanVault(vaultPath, (skillId, error) => {
      invalidIds.push(skillId);
      console.error(`warning: keeping previous index entry for ${skillId}: ${error}`);
    });
    const rows = skills.map(toSkillRow);
    for (const skillId of invalidIds) {
      const previous = getSkillRow(db, skillId);
      if (previous) {
        rows.push(previous);
      }
    }
    replaceSkills(db, rows);
    setIndexMeta(db, "last_indexed_mtime", String(currentMtime));
    backfillEmbeddings().catch(() => {});
  }
}

/**
 * Embed every skill missing a current vector (new or content changed).
 * Called by `skillmux index` and at server startup; failure is tolerated —
 * resolve falls back to lexical-only recall until vectors exist.
 */
export async function backfillEmbeddings(): Promise<number> {
  const { config, db } = await getEnv();
  const clients = getClients();
  const fingerprint = embeddingFingerprint(config);
  const pending = skillsNeedingVectors(db, embeddingDimension(config), fingerprint);
  if (pending.length === 0) return 0;

  const BATCH_SIZE = 10;
  let count = 0;
  for (let i = 0; i < pending.length; i += BATCH_SIZE) {
    const chunk = pending.slice(i, i + BATCH_SIZE);
    try {
      const vectors = await clients.embed(chunk.map(rerankText));
      chunk.forEach((row, j) => {
        upsertVector(db, row.skill_id, row.content_sha256, fingerprint, vectors[j]!);
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
 * Watch the vault and fold file changes into the index within seconds.
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
  await syncVaultIfNeeded();

  // Short-circuit: exact match on skill_id, title, or alias (First Principles #1)
  const exactMatch = findExactMatch(db, input.query);
  if (exactMatch) {
    const delivery = await deliverSkill(db, config, exactMatch.skill_id);
    const result: ResolveResult = {
      outcome: "matched",
      retrieval: "exact",
      skill_id: exactMatch.skill_id,
      title: delivery.title,
      content_sha256: delivery.content_sha256,
      score: 1.0,
      margin: 1.0,
      body: delivery.body,
      files: delivery.files,
    };
    insertAudit(
      db,
      buildAuditRow({
        id: 0,
        ts: new Date().toISOString(),
        query: input.query,
        outcome: "matched",
        retrieval: "exact",
        candidates: [{ skill_id: exactMatch.skill_id, score: 1.0 }],
        selected_skill_id: exactMatch.skill_id,
        latency_ms: Math.round(performance.now() - t0),
      }),
    );
    return result;
  }

  const clients = getClients();

  const lexical = ftsSearch(db, input.query, config.recall.k_lexical);

  let retrieval: RetrievalCapability = "lexical";
  let rows = lexical;
  if (!input.forceLexical) {
    try {
      const queryVec = (await clients.embed([input.query]))[0]!;
      const nearest = vectorTopK(db, queryVec, config.recall.k_vector);
      rows = reciprocalRankFusion(lexical, nearest);
      retrieval = "hybrid";
    } catch {
      retrieval = "lexical";
    }
  }

  let scores: number[] | null = null;
  if (clients.rerank && retrieval === "hybrid" && rows.length > 0) {
    try {
      scores = await clients.rerank(
        input.query,
        rows.map((r) => ({ skill_id: r.skill_id, text: rerankText(r) })),
      );
      retrieval = "reranked";
    } catch {
      scores = null;
    }
  }

  const rankedCandidates: RankedCandidate[] = rows
    .map((r, i) => ({
      skill_id: r.skill_id,
      title: r.title,
      description: r.description,
      score: scores?.[i] ?? null,
    }))
    .sort((a, b) => scores === null ? 0 : (b.score ?? -Infinity) - (a.score ?? -Infinity));

  const decisionThresholds = retrieval === "reranked" && config.inference.mode === "remote"
    ? { candidate_limit: config.thresholds.candidate_limit, ...config.inference.thresholds }
    : config.thresholds;
  const decision = decideResolveOutcome({
    reranked: retrieval === "reranked",
    candidates: rankedCandidates,
    thresholds: decisionThresholds,
  });

  let result: ResolveResult;
  if (decision.outcome === "matched") {
    const delivery = await deliverSkill(db, config, decision.skill_id);
    result = {
      outcome: "matched",
      retrieval: "reranked",
      skill_id: decision.skill_id,
      title: delivery.title,
      content_sha256: delivery.content_sha256,
      score: decision.score,
      margin: decision.margin,
      body: delivery.body,
      files: delivery.files,
    };
  } else if (decision.outcome === "ambiguous") {
    result = {
      outcome: "ambiguous",
      retrieval,
      candidates: decision.candidates.map(({ score: _score, ...candidate }) => candidate),
    };
  } else {
    result = { outcome: "no_match", retrieval, message: NO_MATCH_MESSAGE };
  }

  insertAudit(
    db,
    buildAuditRow({
      id: 0, // assigned by SQLite
      ts: new Date().toISOString(),
      query: input.query,
      outcome: result.outcome,
      retrieval,
      candidates: rankedCandidates.map((c) => ({ skill_id: c.skill_id, score: c.score })),
      selected_skill_id: result.outcome === "matched" ? result.skill_id : null,
      latency_ms: Math.round(performance.now() - t0),
    }),
  );

  return result;
}

export async function fetchSkill(input: FetchSkillInput): Promise<FetchSkillResult> {
  const { config, db } = await getEnv();
  await syncVaultIfNeeded();
  if (getSkillRow(db, input.skill_id) === null) {
    throw new Error(`SKILL_NOT_FOUND: no skill '${input.skill_id}' in the index`);
  }
  return deliverSkill(db, config, input.skill_id);
}
