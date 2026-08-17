import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  applyCalibrationRun,
  assertCalibrationFeasibility,
  computeCorpusFingerprint,
  createInitialCalibrationRun,
  finalizeCalibrationRun,
  getCalibrationObservations,
  getCalibrationRun,
  insertCalibrationRun,
  listCalibrationRuns,
  loadDecisionCasesFromFile,
  openCalibrateDb,
  runCalibration,
  saveCalibrationObservation,
  summarizeDatasetProvenance,
  type CalibrationResult,
  type QueryObservation,
} from "./calibrate";
import { createClients } from "./clients";
import { embeddingFingerprint, expandHome, loadConfig, rerankerFingerprint, resolveConfigPath } from "./config";
import { openIndex } from "./db";
import { CliError } from "./output";
import {
  computeHash,
  getDottedKey,
  getEffectiveConfig,
  getLocalConfigStatus,
  getNestedValue,
  RELOADABLE_KEYS,
  RESTART_REQUIRED_KEYS,
  setDottedKey,
  validateDottedKey,
  type ConfigStatusResponse,
  type SetConfigResult,
} from "./config-service";
import type { ResolvedTarget } from "./context";
import {
  classifyInferenceError,
  configure,
  retrieveAndRerankSnapshot,
  syncVaultIfNeeded,
  type StageTiming,
} from "./router-core";
import type { Clients, Config } from "./types";

/**
 * Maximum retry attempts for transient reranker availability errors during calibration.
 *
 * Single-capacity remote reranker endpoints can suffer isolated blips (e.g. transient
 * connection reset or momentary 503) during long multi-case calibration runs.
 * A small bounded budget of 2 retries (3 attempts total) allows calibration to ride out
 * transient blips without stalling on hard failures.
 */
export const CALIBRATION_RERANK_MAX_RETRIES = 2;

/**
 * Base backoff delay (ms) between reranker retries during calibration.
 *
 * A conservative nonzero delay gives recovering remote endpoints time to settle.
 * Because reranker admission is strictly FIFO serialized, waiting workers remain
 * queued rather than creating synchronized retry storms.
 */
export const CALIBRATION_RERANK_RETRY_BACKOFF_MS = 250;

export interface Capabilities {
  config_read: boolean;
  config_write: boolean;
  calibration: boolean;
  persistence: "writable" | "externally_managed";
  reloadable_keys: string[];
  restart_required_keys: string[];
}

export interface TargetAdapterOptions {
  configPath?: string;
  allowInsecure?: boolean;
  clients?: Clients;
}

/**
 * Aggregate timing data collected during a single calibrateRun invocation.
 *
 * All durations are in milliseconds and are non-negative.
 *
 * Cumulative fields (cumulative_embedding_ms, cumulative_lexical_ms,
 * cumulative_vector_ms, cumulative_reranker_ms, cumulative_checkpoint_ms)
 * represent total worker time summed across all concurrent query retrievals
 * or checkpoint writes. Because queries run concurrently, the sum of these
 * cumulative fields may exceed wall_ms — they measure how much worker time
 * each stage consumed, not how much wall-clock time it contributed.
 */
export interface CalibrationTimingSummary {
  /** Total number of dataset cases. */
  cases_total: number;
  /** Cases actually retrieved in this invocation (not reused from a prior run). */
  cases_executed: number;
  /** Cases loaded from a prior interrupted run (resume observations). */
  cases_reused: number;
  /** Wall-clock duration of the full calibrateRun operation (ms). */
  wall_ms: number;
  /** Duration of the one-time vault synchronization before retrieval (ms). */
  vault_sync_ms: number;
  /** Cumulative worker time spent in embedding across all queries (ms). */
  cumulative_embedding_ms: number;
  /** Cumulative worker time spent in lexical search across all queries (ms). */
  cumulative_lexical_ms: number;
  /** Cumulative worker time spent in vector search across all queries (ms). */
  cumulative_vector_ms: number;
  /** Cumulative worker time spent in reranking across all queries (ms). */
  cumulative_reranker_ms: number;
  /** Cumulative worker time spent writing observation checkpoints (ms). */
  cumulative_checkpoint_ms: number;
  /** Duration of threshold selection and test-split certification (ms). */
  policy_evaluation_ms: number;
}

export interface TargetAdapter {
  getCapabilities(): Promise<Capabilities>;
  getConfigShow(): Promise<{ effective: Config; sources: Record<string, string>; active_revision: string }>;
  getConfigGet(key: string): Promise<unknown>;
  configValidate(): Promise<{ valid: boolean; readiness: unknown }>;
  configDiff(): Promise<{ diff: Record<string, { prior: unknown; resulting: unknown }> }>;
  configSet(key: string, rawValStr: string, opts?: { dryRun?: boolean }): Promise<SetConfigResult>;
  configStatus(): Promise<ConfigStatusResponse>;
  calibrateRun(opts?: {
    datasetPath?: string;
    minAutoMatchPrecision?: number;
    minRetrievalRecallAtK?: number;
    minDeliveredShortlistRecallAtK?: number;
    minAutoMatchCount?: number;
    concurrency?: number;
    resumeRunId?: string;
    onProgress?: (completed: number, total: number) => void;
    /** Opt-in timing collection. When true, onTimingSummary is called after a non-throwing result. */
    timing?: boolean;
    /** Called after calibration completes or fails-gates (not called on throws). */
    onTimingSummary?: (summary: CalibrationTimingSummary) => void;
  }): Promise<{ run_id?: string; result?: CalibrationResult }>;
  calibrateList(): Promise<any[]>;
  calibrateShow(runId: string): Promise<any>;
  calibrateApply(runId: string): Promise<any>;
}

export function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "0.0.0.0" ||
    hostname.startsWith("127.")
  );
}

export class LocalAdapter implements TargetAdapter {
  private configPath: string;
  private clients?: Clients;

  constructor(opts?: TargetAdapterOptions) {
    this.configPath = resolveConfigPath(opts?.configPath);
    this.clients = opts?.clients;
  }

  async getCapabilities(): Promise<Capabilities> {
    const isExternallyManaged = process.env.SKILLMUX_CONFIG_READONLY === "true";
    return {
      config_read: true,
      config_write: !isExternallyManaged,
      calibration: true,
      persistence: isExternallyManaged ? "externally_managed" : "writable",
      reloadable_keys: RELOADABLE_KEYS,
      restart_required_keys: RESTART_REQUIRED_KEYS,
    };
  }

  async getConfigShow(): Promise<{ effective: Config; sources: Record<string, string>; active_revision: string }> {
    const { effective, sources } = await getEffectiveConfig(this.configPath);
    return {
      effective,
      sources,
      active_revision: computeHash(effective),
    };
  }

  async getConfigGet(key: string): Promise<unknown> {
    return getDottedKey(key, this.configPath);
  }

  async configValidate(): Promise<{ valid: boolean; readiness: unknown }> {
    const { effective } = await getEffectiveConfig(this.configPath);
    return { valid: !!effective, readiness: { status: "ready", capability: "hybrid" } };
  }

  async configDiff(): Promise<{ diff: Record<string, { prior: unknown; resulting: unknown }> }> {
    const { effective, sources } = await getEffectiveConfig(this.configPath);
    const diff: Record<string, { prior: unknown; resulting: unknown }> = {};
    for (const [k, src] of Object.entries(sources)) {
      if (src !== "default") {
        diff[k] = { prior: "default", resulting: getNestedValue(effective as any, k) };
      }
    }
    return { diff };
  }

  async configSet(key: string, rawValStr: string, opts?: { dryRun?: boolean }): Promise<SetConfigResult> {
    const caps = await this.getCapabilities();
    if (caps.persistence === "externally_managed") {
      throw new CliError("Configuration is externally managed and cannot be modified", 4);
    }
    validateDottedKey(key);
    return setDottedKey(key, rawValStr, {
      configPath: this.configPath,
      dryRun: opts?.dryRun,
      targetName: "local",
    });
  }

  async configStatus(): Promise<ConfigStatusResponse> {
    return getLocalConfigStatus(this.configPath);
  }

  async calibrateRun(opts?: {
    datasetPath?: string;
    minAutoMatchPrecision?: number;
    minRetrievalRecallAtK?: number;
    minDeliveredShortlistRecallAtK?: number;
    minAutoMatchCount?: number;
    concurrency?: number;
    resumeRunId?: string;
    onProgress?: (completed: number, total: number) => void;
    timing?: boolean;
    onTimingSummary?: (summary: CalibrationTimingSummary) => void;
  }): Promise<{ run_id?: string; result?: CalibrationResult }> {
    const collectTiming = opts?.timing === true;
    const wallStart = collectTiming ? performance.now() : 0;

    const config = await loadConfig(this.configPath);
    const baseClients = this.clients ?? createClients(config);

    // Bounded admission at the calibration reranker boundary: serialize rerank calls
    // so concurrent case retrieval (embedding, lexical, vector) does not overwhelm
    // a single-capacity remote reranker endpoint.
    //
    // If an admitted request encounters a transient reranker_unavailable error,
    // retry with conservative backoff up to CALIBRATION_RERANK_MAX_RETRIES.
    // Non-availability errors (protocol, timeouts) and permanent failures fail closed.
    let rerankQueue = Promise.resolve() as Promise<any>;
    const serializedRerank: typeof baseClients.rerank = baseClients.rerank
      ? (query, docs) => {
          const run = async () => {
            let attempt = 0;
            while (true) {
              try {
                return await baseClients.rerank!(query, docs);
              } catch (err) {
                attempt++;
                const degradationReason = classifyInferenceError("reranker", err);
                if (
                  degradationReason === "reranker_unavailable" &&
                  attempt <= CALIBRATION_RERANK_MAX_RETRIES
                ) {
                  await Bun.sleep(CALIBRATION_RERANK_RETRY_BACKOFF_MS * attempt);
                  continue;
                }
                throw err;
              }
            }
          };
          const next = rerankQueue.then(run, run);
          rerankQueue = next.catch(() => {});
          return next;
        }
      : undefined;

    const clients: Clients = {
      ...baseClients,
      rerank: serializedRerank,
    };
    configure({ config, clients });

    // Measure vault synchronization
    let vault_sync_ms = 0;
    if (collectTiming) {
      const t0 = performance.now();
      await syncVaultIfNeeded();
      vault_sync_ms = Math.max(0, performance.now() - t0);
    } else {
      await syncVaultIfNeeded();
    }

    const candidateLimit =
      config.output?.ambiguous_candidate_limit ?? config.thresholds?.candidate_limit ?? 5;
    const datasetFile = opts?.datasetPath ?? join(expandHome(config.state_dir), "queries.json");
    const indexDb = openIndex(expandHome(config.state_dir));
    let indexedSkills: Array<{ skill_id: string; content_sha256: string }>;
    let corpusFingerprint: string;
    try {
      indexedSkills = indexDb
        .query("SELECT skill_id, content_sha256 FROM skills ORDER BY skill_id")
        .all() as Array<{ skill_id: string; content_sha256: string }>;
      corpusFingerprint = computeCorpusFingerprint(indexDb);
    } finally {
      indexDb.close();
    }
    const cases = loadDecisionCasesFromFile(
      datasetFile,
      indexedSkills.map((skill) => skill.skill_id),
    );
    const fingerprint = rerankerFingerprint(config);
    if (!fingerprint) {
      throw new Error("A configured remote reranker is required to record calibration.");
    }
    const datasetText = await Bun.file(datasetFile).text();
    const datasetHash = createHash("sha256").update(datasetText).digest("hex");
    const embedFp = embeddingFingerprint(config);
    const recallSettings = {
      k_lexical: config.recall.k_lexical,
      k_vector: config.recall.k_vector,
      k_rerank: config.recall.k_rerank ?? Math.min(10, config.recall.k_lexical + config.recall.k_vector),
    };
    const minAutoMatchPrecision = opts?.minAutoMatchPrecision ?? 0.75;
    const minAutoMatchCount = opts?.minAutoMatchCount ?? 15;
    const minDeliveredShortlistRecallAtK =
      opts?.minDeliveredShortlistRecallAtK ??
      opts?.minRetrievalRecallAtK ??
      0.95;
    const minShortlistRecallAt5 = opts?.minRetrievalRecallAtK ?? 0.95;
    const concurrency = opts?.concurrency ?? 4;

    assertCalibrationFeasibility(cases, {
      minAutoMatchPrecision,
      minAutoMatchCount,
    });

    const db = openCalibrateDb(expandHome(config.state_dir));
    let runId: string;
    let initialObservations: Map<number, QueryObservation> | undefined = undefined;

    // Cumulative timing accumulators (only used when collectTiming=true)
    let cumulative_embedding_ms = 0;
    let cumulative_lexical_ms = 0;
    let cumulative_vector_ms = 0;
    let cumulative_reranker_ms = 0;
    let cumulative_checkpoint_ms = 0;

    try {
      if (opts?.resumeRunId) {
        runId = opts.resumeRunId;
        const existingRun = getCalibrationRun(db, runId);
        if (!existingRun) {
          throw new Error(`Calibration run "${runId}" not found`);
        }
        if (existingRun.status !== "running") {
          throw new Error(`Cannot resume completed calibration run "${runId}"`);
        }
        if (existingRun.dataset_hash !== datasetHash) {
          throw new Error("Dataset hash mismatch: cannot resume run with a different dataset");
        }
        if (existingRun.corpus_fingerprint !== corpusFingerprint) {
          throw new Error("Corpus fingerprint mismatch: cannot resume run with modified vault skills");
        }
        if (existingRun.embedding_fingerprint !== embedFp) {
          throw new Error("Embedding fingerprint mismatch: cannot resume run with different embedding configuration");
        }
        if (existingRun.reranker_fingerprint !== fingerprint) {
          throw new Error("Reranker fingerprint mismatch: cannot resume run with different reranker configuration");
        }
        if (existingRun.candidate_limit !== candidateLimit) {
          throw new Error("Candidate limit mismatch: cannot resume run with different candidate limit");
        }
        if (
          existingRun.recall_settings &&
          JSON.stringify(existingRun.recall_settings) !== JSON.stringify(recallSettings)
        ) {
          throw new Error("Recall settings mismatch: cannot resume run with different recall parameters");
        }
        if (existingRun.min_auto_match_precision !== minAutoMatchPrecision) {
          throw new Error("Certification gate mismatch: min_auto_match_precision differs from original run");
        }
        if ((existingRun.min_auto_match_count ?? 1) !== minAutoMatchCount) {
          throw new Error("Certification gate mismatch: min_auto_match_count differs from original run");
        }
        if (
          (existingRun.min_delivered_shortlist_recall_at_k ?? existingRun.min_shortlist_recall_at_5) !==
          minDeliveredShortlistRecallAtK
        ) {
          throw new Error(
            "Certification gate mismatch: min_delivered_shortlist_recall_at_k differs from original run",
          );
        }
        if (existingRun.min_shortlist_recall_at_5 !== minShortlistRecallAt5) {
          throw new Error("Certification gate mismatch: min_retrieval_recall_at_k differs from original run");
        }

        initialObservations = getCalibrationObservations(db, runId);
        if (initialObservations.size === 0 && existingRun.observations && existingRun.observations.length > 0) {
          existingRun.observations.forEach((obs, idx) => initialObservations!.set(idx, obs));
        }
      } else {
        runId = `run_${crypto.randomUUID()}`;
        createInitialCalibrationRun(db, {
          run_id: runId,
          created_at: new Date().toISOString(),
          status: "running",
          reranker_fingerprint: fingerprint,
          embedding_fingerprint: embedFp,
          corpus_fingerprint: corpusFingerprint,
          dataset_hash: datasetHash,
          dataset_provenance: summarizeDatasetProvenance(cases),
          recall_settings: recallSettings,
          candidate_limit: candidateLimit,
          min_auto_match_precision: minAutoMatchPrecision,
          min_auto_match_count: minAutoMatchCount,
          min_delivered_shortlist_recall_at_k: minDeliveredShortlistRecallAtK,
          min_shortlist_recall_at_5: minShortlistRecallAt5,
        });
      }

      const casesReused = initialObservations?.size ?? 0;

      const onProgress = opts?.onProgress ?? ((completed, total) => {
        process.stderr.write(`Calibration observations: ${completed}/${total}\n`);
      });

      const retrievalTiming = collectTiming
        ? {
            onTiming: (timing: StageTiming) => {
              cumulative_embedding_ms += timing.embedding_ms;
              cumulative_lexical_ms += timing.lexical_ms;
              cumulative_vector_ms += timing.vector_ms;
              cumulative_reranker_ms += timing.reranker_ms;
            },
          }
        : undefined;

      const getRankedCandidates = async (query: string) => {
        const res = await retrieveAndRerankSnapshot(
          { query, forceLexical: false },
          retrievalTiming,
        );
        if (res.retrieval !== "reranked") {
          throw new Error(
            "Calibration requires successful hybrid retrieval and reranking for every query.",
          );
        }
        return res.candidates.map((candidate) => ({
          skill_id: candidate.skill_id,
          score: candidate.score ?? 0,
        }));
      };

      let policyEvaluationStart = 0;

      const result = await runCalibration({
        cases,
        getRankedCandidates,
        reranker: clients.rerank,
        candidateLimit,
        minAutoMatchPrecision,
        minRetrievalRecallAtK: minShortlistRecallAt5,
        minDeliveredShortlistRecallAtK,
        minAutoMatchCount,
        concurrency,
        initialObservations,
        onProgress,
        onObservation: collectTiming
          ? (obs, caseIdx) => {
              const t0 = performance.now();
              saveCalibrationObservation(db, runId, caseIdx, obs);
              const t1 = performance.now();
              cumulative_checkpoint_ms += Math.max(0, t1 - t0);
            }
          : (obs, caseIdx) => {
              saveCalibrationObservation(db, runId, caseIdx, obs);
            },
        onObservationsReady: collectTiming
          ? () => {
              policyEvaluationStart = performance.now();
            }
          : undefined,
      });

      // policy_evaluation_ms: threshold selection + certification duration
      const policyEvalEnd = collectTiming ? performance.now() : 0;

      finalizeCalibrationRun(db, {
        run_id: runId,
        status: result.status,
        failed_reason: result.failed_reason,
        selected_thresholds: result.selected_thresholds,
        tune_metrics: result.tune_metrics,
        test_metrics: result.test_metrics,
        observations: result.observations,
      });

      // Emit timing summary after a non-throwing result (completed or failed-gates).
      // Never called when calibrateRun throws.
      if (collectTiming && opts?.onTimingSummary) {
        const wall_ms = Math.max(0, performance.now() - wallStart);
        // policy_evaluation_ms covers threshold selection + test-split certification,
        // the internal work runCalibration does after all observations are collected.
        const policy_evaluation_ms = Math.max(0, policyEvalEnd - policyEvaluationStart);

        const cases_reused = casesReused;
        const cases_total = cases.length;
        const cases_executed = cases_total - cases_reused;

        opts.onTimingSummary({
          cases_total,
          cases_executed,
          cases_reused,
          wall_ms,
          vault_sync_ms,
          cumulative_embedding_ms,
          cumulative_lexical_ms,
          cumulative_vector_ms,
          cumulative_reranker_ms,
          cumulative_checkpoint_ms,
          policy_evaluation_ms,
        });
      }

      return { run_id: runId, result };
    } finally {
      db.close();
    }
  }


  async calibrateList(): Promise<any[]> {
    const config = await loadConfig(this.configPath);
    const db = openCalibrateDb(expandHome(config.state_dir));
    try {
      return listCalibrationRuns(db);
    } finally {
      db.close();
    }
  }

  async calibrateShow(runId: string): Promise<any> {
    const config = await loadConfig(this.configPath);
    const db = openCalibrateDb(expandHome(config.state_dir));
    try {
      const run = getCalibrationRun(db, runId);
      if (!run) throw new Error(`Calibration run "${runId}" not found`);
      return run;
    } finally {
      db.close();
    }
  }

  async calibrateApply(runId: string): Promise<any> {
    const config = await loadConfig(this.configPath);
    const db = openCalibrateDb(expandHome(config.state_dir));
    try {
      const run = getCalibrationRun(db, runId);
      if (!run) throw new Error(`Calibration run "${runId}" not found`);
      await applyCalibrationRun(db, runId, expandHome(this.configPath), {
        currentRerankerFingerprint: rerankerFingerprint(config),
      });
      return { ok: true, run_id: runId };
    } finally {
      db.close();
    }
  }
}

export class RemoteAdapter implements TargetAdapter {
  private serverUrl: string;
  private tokenEnv?: string;
  private allowInsecure: boolean;

  constructor(target: { server: string; token_env?: string }, opts?: TargetAdapterOptions) {
    this.serverUrl = target.server.replace(/\/$/, "");
    this.tokenEnv = target.token_env;
    this.allowInsecure = opts?.allowInsecure ?? false;

    this.validateSecurity();
  }

  private validateSecurity(): void {
    try {
      const url = new URL(this.serverUrl);
      if (url.protocol === "http:" && !isLoopbackHost(url.hostname) && !this.allowInsecure) {
        throw new Error(
          `Plaintext HTTP admin targets are not allowed for non-loopback server "${this.serverUrl}". Pass --allow-insecure to bypass.`
        );
      }
    } catch (err: any) {
      if (err.message.includes("Plaintext HTTP")) throw err;
      throw new Error(`Invalid server URL "${this.serverUrl}"`);
    }
  }

  private getAuthHeader(): Record<string, string> {
    const envVar = this.tokenEnv || "SKILLMUX_ADMIN_TOKEN";
    const token = process.env[envVar];
    if (!token) {
      throw new Error(`Environment variable "${envVar}" for administrative authentication is empty`);
    }
    return { Authorization: `Bearer ${token}` };
  }

  private async fetchJson(path: string, options: RequestInit = {}): Promise<{ status: number; headers: Headers; data: any }> {
    const url = `${this.serverUrl}${path}`;
    const headers = new Headers(options.headers);
    for (const [k, v] of Object.entries(this.getAuthHeader())) {
      headers.set(k, v);
    }

    try {
      const res = await fetch(url, { ...options, headers });
      const text = await res.text();
      let data: any = text;
      try {
        data = JSON.parse(text);
      } catch {
        // text
      }
      if (res.status === 401 || res.status === 403) {
        const message = typeof data === "object" && data ? data.message || data.error || data : data;
        throw new CliError(`Remote server rejected the request (${res.status}): ${message}`, 3);
      }
      return { status: res.status, headers: res.headers, data };
    } catch (err: any) {
      if (err instanceof CliError) throw err;
      throw new CliError(`Failed to reach remote server "${this.serverUrl}": ${err.message}`, 3);
    }
  }

  async getCapabilities(): Promise<Capabilities> {
    const { status, data } = await this.fetchJson("/admin/v1/capabilities");
    if (status !== 200) {
      throw new Error(`Remote capability discovery failed (${status}): ${typeof data === "object" ? data.message || data.error : data}`);
    }
    return data as Capabilities;
  }

  async getConfigShow(): Promise<{ effective: Config; sources: Record<string, string>; active_revision: string }> {
    const { status, data } = await this.fetchJson("/admin/v1/config");
    if (status !== 200) {
      throw new Error(`Remote config fetch failed (${status}): ${typeof data === "object" ? data.message || data.error : data}`);
    }
    return data;
  }

  async getConfigGet(key: string): Promise<unknown> {
    validateDottedKey(key);
    const { effective } = await this.getConfigShow();
    return getNestedValue(effective as any, key);
  }

  async configValidate(): Promise<{ valid: boolean; readiness: unknown }> {
    const show = await this.getConfigShow();
    return { valid: true, readiness: show.effective };
  }

  async configDiff(): Promise<{ diff: Record<string, { prior: unknown; resulting: unknown }> }> {
    const { effective, sources } = await this.getConfigShow();
    const diff: Record<string, { prior: unknown; resulting: unknown }> = {};
    for (const [k, src] of Object.entries(sources)) {
      if (src !== "default") {
        diff[k] = { prior: "default", resulting: getNestedValue(effective as any, k) };
      }
    }
    return { diff };
  }

  async configSet(key: string, rawValStr: string, opts?: { dryRun?: boolean }): Promise<SetConfigResult> {
    const caps = await this.getCapabilities();
    if (!caps.config_write || caps.persistence === "externally_managed") {
      throw new CliError("Remote server configuration is externally managed or read-only", 4);
    }

    const { status: showStatus, headers: showHeaders, data: showData } = await this.fetchJson("/admin/v1/config");
    if (showStatus !== 200) {
      throw new Error(`Remote config fetch failed (${showStatus})`);
    }

    const etag = showHeaders.get("etag") || `"${showData.active_revision}"`;

    if (opts?.dryRun) {
      const priorVal = getNestedValue(showData.effective, key);
      return {
        ok: true,
        key,
        prior_val: priorVal,
        resulting_val: rawValStr,
        target: "remote",
        prior_revision: showData.active_revision,
        resulting_revision: showData.active_revision,
        persistence: "not_persisted",
        application: "activated",
        readiness: { status: "ready", capability: "hybrid" },
        restart_required_keys: [],
      };
    }

    const { status, data } = await this.fetchJson("/admin/v1/config", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "If-Match": etag,
      },
      body: JSON.stringify({ changes: { [key]: rawValStr } }),
    });

    if (status === 409) {
      if (data?.error === "CONFIG_REVISION_CONFLICT") {
        throw new CliError(`Revision conflict: ${data.message || "Remote configuration was modified concurrently"}`, 4);
      }
      if (data?.error === "CONFIG_EXTERNALLY_MANAGED") {
        throw new CliError("Configuration is externally managed on the remote server", 4);
      }
    }

    if (status !== 200) {
      throw new Error(`Remote config set failed (${status}): ${data?.message || data?.error || data}`);
    }

    return data;
  }

  async configStatus(): Promise<ConfigStatusResponse> {
    const { status, data } = await this.fetchJson("/admin/v1/config");
    if (status !== 200) {
      throw new Error(`Remote status fetch failed (${status}): ${data?.message || data}`);
    }
    return data.runtime;
  }

  async calibrateRun(opts?: {
    datasetPath?: string;
    minAutoMatchPrecision?: number;
    minRetrievalRecallAtK?: number;
    minDeliveredShortlistRecallAtK?: number;
    minAutoMatchCount?: number;
    concurrency?: number;
    resumeRunId?: string;
    onProgress?: (completed: number, total: number) => void;
    timing?: boolean;
    onTimingSummary?: (summary: CalibrationTimingSummary) => void;
  }): Promise<{ run_id?: string; result?: CalibrationResult }> {
    void opts;
    throw this.remoteCalibrationNotImplemented();
  }


  async calibrateList(): Promise<any[]> {
    throw this.remoteCalibrationNotImplemented();
  }

  async calibrateShow(runId: string): Promise<any> {
    void runId;
    throw this.remoteCalibrationNotImplemented();
  }

  async calibrateApply(runId: string): Promise<any> {
    void runId;
    throw this.remoteCalibrationNotImplemented();
  }

  private remoteCalibrationNotImplemented(): CliError {
    return new CliError(
      `Remote calibration is not implemented for target ${this.serverUrl}; ` +
        "run `skillmux calibrate` against a local target.",
      2,
    );
  }
}

export function createTargetAdapter(target: ResolvedTarget, opts?: TargetAdapterOptions): TargetAdapter {
  if (target.type === "local") {
    return new LocalAdapter(opts);
  } else {
    return new RemoteAdapter({ server: target.server, token_env: target.token_env }, opts);
  }
}
