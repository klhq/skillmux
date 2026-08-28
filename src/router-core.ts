import type { Database } from "bun:sqlite";
import { existsSync, watch } from "node:fs";
import { join } from "node:path";
import { buildAuditRow } from "./audit";
import { embeddingDimension, embeddingFingerprint, expandHome, loadConfig } from "./config";
import { RemoteInferenceError } from "./clients";
import {
  deleteSkill,
  findExactMatch,
  ftsSearch,
  getAuditRowByRequestId,
  getIndexMeta,
  getSkillRow,
  ingestVault,
  insertAudit,
  insertFetch,
  openAudit,
  openIndex,
  pruneAudit,
  replaceSkills,
  setIndexMeta,
  skillCount,
  skillsNeedingVectors,
  toSkillRow,
  upsertSkill,
  upsertVector,
  vectorTopK,
} from "./db";
import type { PruneResult, SkillRow } from "./db";
import type {
  RankedCandidate,
  RetrievalCapability,
  Clients,
  Config,
  DegradationReason,
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
  scanVaults,
  vaultResolutionOrder,
  sha256Hex,
  SKILL_ID_PATTERN,
} from "./vault";

function maxVaultMtime(vaultPath: string, localVaultPaths: string[]): number {
  return Math.max(getVaultMaxMtime(vaultPath), ...localVaultPaths.map(getVaultMaxMtime));
}

export { buildAuditRow } from "./audit";
export { loadConfig } from "./config";
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
let env: { config: Config; db: Database; auditDb: Database } | null = null;
let lastAuditPruneAt: number | null = null;

const AUDIT_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Replace config/client overrides wholesale (tests, ops). Resets the cached index handle. */
export function configure(opts: Overrides): void {
  overrides = opts;
  env = null;
  lastAuditPruneAt = null;
}

async function getEnv(): Promise<{ config: Config; db: Database; auditDb: Database }> {
  if (env) return env;
  const config = overrides.config ?? (await loadConfig());
  const stateDir = expandHome(config.state_dir);
  const db = openIndex(stateDir);
  const auditDb = openAudit(stateDir);
  if (skillCount(db) === 0) {
    const vaultPath = expandHome(config.vault_path);
    const localVaultPaths = config.local_vault_paths.map(expandHome);
    ingestVault(db, await scanVaults(vaultPath, localVaultPaths));
    setIndexMeta(db, "last_indexed_mtime", String(maxVaultMtime(vaultPath, localVaultPaths)));
  }
  env = { config, db, auditDb };
  return env;
}

function getClients(): Clients {
  return { ...defaultClients, ...overrides.clients };
}

/** Runtime accessor for the eval harness and CLI — not part of the MCP surface. */
export async function getRuntime(): Promise<{
  config: Config;
  db: Database;
  auditDb: Database;
  clients: Clients;
}> {
  const { config, db, auditDb } = await getEnv();
  return { config, db, auditDb, clients: getClients() };
}

export function closeRuntime(): void {
  env?.db.close();
  env?.auditDb.close();
  env = null;
}

/**
 * Zero-loss delivery: read SKILL.md from disk now, hash it, and if the
 * index is stale re-index that skill — never serve stale bytes.
 */
async function deliverSkill(db: Database, config: Config, skillId: string): Promise<FetchSkillResult> {
  const vaultPath = expandHome(config.vault_path);
  const localVaultPaths = config.local_vault_paths.map(expandHome);
  const candidates = vaultResolutionOrder(vaultPath, localVaultPaths);

  // Existence alone (resolveSkillRoot's check) isn't enough here: an unparseable
  // local_vault_paths override would otherwise shadow a perfectly valid vault_path
  // copy of the same skill_id, since it's checked first. Skip a broken override and
  // fall through to the next root — mirroring scanVault/rebuildIndex's tolerance for
  // unparseable content. The last candidate (always vault_path) is never skipped on
  // parse failure, matching the pre-existing single-root behavior where a broken
  // vault_path copy propagates its parse error rather than being silently swallowed.
  let root: string | null = null;
  let bytes: Uint8Array | null = null;
  let raw = "";
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i]!;
    const file = Bun.file(join(candidate, skillId, "SKILL.md"));
    if (!(await file.exists())) continue;
    const candidateBytes = await file.bytes();
    const candidateRaw = decodeUtf8Strict(candidateBytes);
    if (i < candidates.length - 1) {
      try {
        parseSkillMd(skillId, candidateRaw);
      } catch {
        continue;
      }
    }
    root = candidate;
    bytes = candidateBytes;
    raw = candidateRaw;
    break;
  }

  if (root === null || bytes === null) {
    // Deleted on disk but the watcher hasn't caught up: drop the stale row and
    // surface the schema's error code rather than a raw ENOENT.
    deleteSkill(db, skillId);
    throw new Error(`SKILL_NOT_FOUND: skill '${skillId}' no longer exists in the vault`);
  }
  const contentSha256 = sha256Hex(bytes);
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
    files: listSupportingFiles(root, skillId),
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
  const localVaultPaths = config.local_vault_paths.map(expandHome);
  const currentMtime = maxVaultMtime(vaultPath, localVaultPaths);
  const invalidIds: string[] = [];
  const skills = await scanVaults(vaultPath, localVaultPaths, (skillId, error) => {
    invalidIds.push(skillId);
    onInvalid?.(skillId, error);
  });
  const rows = skills.map(toSkillRow);
  // A skill_id invalid in one root (e.g. a local_vault_paths entry being edited) can
  // still be valid in another (e.g. vault_path) — scanVaults already resolved that
  // in `skills`. Only retain the previous row for ids that came back invalid
  // everywhere; otherwise this duplicates the skill_id and violates the
  // skills.skill_id PRIMARY KEY on replaceSkills's plain INSERT.
  const validIds = new Set(skills.map((s) => s.skill_id));
  const retained: string[] = [];
  for (const skillId of invalidIds) {
    if (validIds.has(skillId)) continue;
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
  const localVaultPaths = config.local_vault_paths.map(expandHome);
  const currentMtime = maxVaultMtime(vaultPath, localVaultPaths);
  const lastIndexed = getIndexMeta(db, "last_indexed_mtime");

  if (lastIndexed === null || currentMtime > Number(lastIndexed)) {
    const invalidIds: string[] = [];
    const skills = await scanVaults(vaultPath, localVaultPaths, (skillId, error) => {
      invalidIds.push(skillId);
      console.error(`warning: keeping previous index entry for ${skillId}: ${error}`);
    });
    const rows = skills.map(toSkillRow);
    // See rebuildIndex: a skill_id invalid in one root can still be valid in
    // another that scanVaults already resolved — don't re-add its previous row.
    const validIds = new Set(skills.map((s) => s.skill_id));
    for (const skillId of invalidIds) {
      if (validIds.has(skillId)) continue;
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
      db.transaction(() => {
        chunk.forEach((row, j) => {
          const vector = vectors[j];
          if (!vector) throw new Error("Embedding client returned an incomplete batch.");
          upsertVector(db, row.skill_id, row.content_sha256, fingerprint, vector);
        });
      })();
      count += chunk.length;
    } catch (err) {
      if (
        i === 0 ||
        (err instanceof RemoteInferenceError &&
          (err.kind === "configuration" || err.kind === "protocol"))
      ) {
        throw err;
      }
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

  // A fresh installation may not have a vault checkout yet. Serving an empty
  // vault is valid; leave live indexing inactive until the next server start
  // finds a checkout rather than failing startup with ENOENT.
  if (!existsSync(vaultPath)) return () => {};

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
  const { config, db, auditDb } = await getEnv();
  await syncVaultIfNeeded();

  if (input.top_k !== undefined) {
    if (!Number.isInteger(input.top_k) || input.top_k < 1) {
      throw new Error(`Invalid top_k: ${input.top_k} must be a positive integer`);
    }
    if (input.top_k > config.output.max_top_k) {
      throw new Error(
        `Invalid top_k: ${input.top_k} exceeds max_top_k of ${config.output.max_top_k}`,
      );
    }
  }

  const effectiveTopK = input.top_k ?? config.output.top_k;
  const retrievalResult = await retrieveAndRerank(input);
  const { retrieval, candidates: rankedCandidates } = retrievalResult;

  const candidates: RankedCandidate[] = rankedCandidates
    .slice(0, effectiveTopK)
    .map((c, index) => ({
      rank: index + 1,
      skill_id: c.skill_id,
      description: c.description,
      score: c.score,
    }));

  const requestId = crypto.randomUUID();

  const result: ResolveResult = {
    request_id: requestId,
    retrieval,
    ...(retrievalResult.degraded_from
      ? {
          degraded_from: retrievalResult.degraded_from,
          degradation_reason: retrievalResult.degradation_reason,
        }
      : {}),
    candidates,
  };

  insertAudit(
    auditDb,
    buildAuditRow({
      id: 0, // assigned by SQLite
      ts: new Date().toISOString(),
      request_id: requestId,
      query: input.query,
      retrieval,
      degraded_from: retrievalResult.degraded_from ?? null,
      degradation_reason: retrievalResult.degradation_reason ?? null,
      candidates: candidates.map((c) => ({ skill_id: c.skill_id, score: c.score })),
      latency_ms: Math.round(performance.now() - t0),
    }),
  );

  return result;
}

export interface RawCandidate {
  skill_id: string;
  title: string;
  description: string;
  score: number | null;
}

export interface RetrievalResult {
  retrieval: Exclude<RetrievalCapability, "exact">;
  degraded_from?: "reranked" | "hybrid";
  degradation_reason?: DegradationReason;
  candidates: RawCandidate[];
  trace: Array<{
    skill_id: string;
    lexical_rank: number | null;
    fused_rank: number | null;
    reranked_rank: number | null;
  }>;
}

export function classifyInferenceError(
  stage: "embedding" | "reranker",
  error: unknown,
): DegradationReason {
  const isTimeout =
    (error as { name?: string })?.name === "TimeoutError" ||
    (error as { name?: string })?.name === "AbortError" ||
    String(error).toLowerCase().includes("timeout") ||
    String(error).toLowerCase().includes("aborted");

  if (isTimeout) {
    return stage === "embedding" ? "embedding_timeout" : "reranker_timeout";
  }

  if (error instanceof RemoteInferenceError) {
    if (error.kind === "protocol") {
      return stage === "embedding" ? "embedding_protocol_error" : "reranker_protocol_error";
    }
    return stage === "embedding" ? "embedding_unavailable" : "reranker_unavailable";
  }

  const msg = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (
    msg.includes("protocol") ||
    msg.includes("malformed") ||
    msg.includes("invalid") ||
    msg.includes("json")
  ) {
    return stage === "embedding" ? "embedding_protocol_error" : "reranker_protocol_error";
  }

  return stage === "embedding" ? "embedding_unavailable" : "reranker_unavailable";
}

/**
 * Retrieve the full fused candidate set, optionally rerank it, and synchronize
 * the vault before reading the index.
 */
export async function retrieveAndRerank(
  input: ResolveSkillInput,
): Promise<RetrievalResult> {
  await syncVaultIfNeeded();
  const { config, db } = await getEnv();
  const clients = getClients();

  const embedPromise =
    !input.forceLexical && clients.embed
      ? clients.embed([input.query]).then(
        (res) => res,
        (err) => ({ error: err }),
      )
      : null;

  const lexical = ftsSearch(db, input.query, config.recall.k_lexical);
  const lexicalRanks = new Map(lexical.map((row, index) => [row.skill_id, index + 1]));

  let retrieval: RetrievalResult["retrieval"] = "lexical";
  let degraded_from: RetrievalResult["degraded_from"] = undefined;
  let degradation_reason: RetrievalResult["degradation_reason"] = undefined;
  let rows = lexical;
  let fusedRows: SkillRow[] | null = null;

  if (embedPromise) {
    const embedRes = await embedPromise;
    if (embedRes && typeof embedRes === "object" && "error" in embedRes) {
      retrieval = "lexical";
      degraded_from = clients.rerank ? "reranked" : "hybrid";
      degradation_reason = classifyInferenceError("embedding", embedRes.error);
      console.error(
        JSON.stringify({
          level: "warn",
          stage: "embedding",
          degraded_from,
          reason: degradation_reason,
        }),
      );
    } else {
      try {
        const queryVec = (embedRes as Float32Array[])[0];
        if (!queryVec) throw new Error("Embedding client returned no query vector.");
        const nearest = vectorTopK(db, queryVec, config.recall.k_vector);
        rows = reciprocalRankFusion(lexical, nearest);
        fusedRows = rows;
        retrieval = "hybrid";
      } catch (embedError) {
        retrieval = "lexical";
        degraded_from = clients.rerank ? "reranked" : "hybrid";
        degradation_reason = classifyInferenceError("embedding", embedError);
        console.error(
          JSON.stringify({
            level: "warn",
            stage: "embedding",
            degraded_from,
            reason: degradation_reason,
          }),
        );
      }
    }
  }

  let scores: number[] | null = null;
  if (clients.rerank && retrieval === "hybrid" && rows.length > 0) {
    const kRerank = config.recall.k_rerank ?? 10;
    const rerankCandidates = rows.slice(0, kRerank);
    try {
      scores = await clients.rerank(
        input.query,
        rerankCandidates.map((r) => ({ skill_id: r.skill_id, text: rerankText(r) })),
      );
      retrieval = "reranked";
      rows = rerankCandidates;
    } catch (rerankError) {
      scores = null;
      degraded_from = "reranked";
      degradation_reason = classifyInferenceError("reranker", rerankError);
      console.error(
        JSON.stringify({
          level: "warn",
          stage: "reranker",
          degraded_from,
          reason: degradation_reason,
        }),
      );
    }
  }

  const candidates = rows
    .map((r, i) => ({
      skill_id: r.skill_id,
      title: r.title,
      description: r.description,
      score: scores?.[i] ?? null,
    }))
    .sort((a, b) => scores === null ? 0 : (b.score ?? -Infinity) - (a.score ?? -Infinity));
  const rerankedRanks = retrieval === "reranked"
    ? new Map(candidates.map((candidate, index) => [candidate.skill_id, index + 1]))
    : new Map<string, number>();
  const traceRows = fusedRows ?? rows;

  return {
    retrieval,
    ...(degraded_from ? { degraded_from, degradation_reason } : {}),
    candidates,
    trace: traceRows.map((row, index) => ({
      skill_id: row.skill_id,
      lexical_rank: lexicalRanks.get(row.skill_id) ?? null,
      fused_rank: fusedRows ? index + 1 : null,
      reranked_rank: rerankedRanks.get(row.skill_id) ?? null,
    })),
  };
}

/**
 * AC14: runs at most once per 24 hours per process. Callers must not await
 * this on the startup or resolve path -- it is meant to be fired and left to
 * resolve in the background so it never blocks readiness or a resolve.
 */
export async function pruneAuditIfDue(now: Date = new Date()): Promise<PruneResult | null> {
  const { config, auditDb } = await getEnv();
  const retentionDays = config.audit?.retention_days ?? 90;
  if (retentionDays <= 0) return null;
  if (lastAuditPruneAt !== null && now.getTime() - lastAuditPruneAt < AUDIT_PRUNE_INTERVAL_MS) {
    return null;
  }
  lastAuditPruneAt = now.getTime();
  return pruneAudit(auditDb, retentionDays, now);
}

export async function fetchSkill(input: FetchSkillInput): Promise<FetchSkillResult> {
  const { config, db, auditDb } = await getEnv();
  await syncVaultIfNeeded();
  if (getSkillRow(db, input.skill_id) === null) {
    throw new Error(`SKILL_NOT_FOUND: no skill '${input.skill_id}' in the index`);
  }
  const result = await deliverSkill(db, config, input.skill_id);

  let resolveAuditId: number | null = null;
  let rankAtResolve: number | null = null;
  if (input.request_id) {
    const resolveRow = getAuditRowByRequestId(auditDb, input.request_id);
    if (resolveRow) {
      resolveAuditId = resolveRow.id;
      const index = resolveRow.candidates.findIndex((c) => c.skill_id === input.skill_id);
      rankAtResolve = index === -1 ? null : index + 1;
    }
  }

  insertFetch(auditDb, {
    ts: new Date().toISOString(),
    skill_id: input.skill_id,
    request_id: input.request_id ?? null,
    resolve_audit_id: resolveAuditId,
    rank_at_resolve: rankAtResolve,
  });

  return result;
}
