import { Database } from "bun:sqlite";
import { join } from "node:path";
import { applyCalibrationRun, getCalibrationRun, listCalibrationRuns, loadDecisionCasesFromFile, openCalibrateDb, runCalibration, type CalibrationResult } from "./calibrate";
import { createClients } from "./clients";
import { DEFAULT_CONFIG_PATH, expandHome, loadConfig } from "./config";
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
import { resolveSkill } from "./router-core";
import type { Config } from "./types";

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
}

export interface TargetAdapter {
  getCapabilities(): Promise<Capabilities>;
  getConfigShow(): Promise<{ effective: Config; sources: Record<string, string>; active_revision: string }>;
  getConfigGet(key: string): Promise<unknown>;
  configValidate(): Promise<{ valid: boolean; readiness: unknown }>;
  configDiff(): Promise<{ diff: Record<string, { prior: unknown; resulting: unknown }> }>;
  configSet(key: string, rawValStr: string, opts?: { dryRun?: boolean }): Promise<SetConfigResult>;
  configStatus(): Promise<ConfigStatusResponse>;
  calibrateRun(opts?: { datasetPath?: string }): Promise<{ run_id?: string; result?: CalibrationResult }>;
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

  constructor(opts?: TargetAdapterOptions) {
    this.configPath = opts?.configPath ?? DEFAULT_CONFIG_PATH;
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
    return setDottedKey(key, rawValStr, {
      configPath: this.configPath,
      dryRun: opts?.dryRun,
      targetName: "local",
    });
  }

  async configStatus(): Promise<ConfigStatusResponse> {
    return getLocalConfigStatus(this.configPath);
  }

  async calibrateRun(opts?: { datasetPath?: string }): Promise<{ run_id?: string; result?: CalibrationResult }> {
    const config = await loadConfig(this.configPath);
    const datasetFile = opts?.datasetPath ?? join(expandHome(config.state_dir), "queries.json");
    const cases = loadDecisionCasesFromFile(datasetFile);
    const clients = createClients(config);
    const result = await runCalibration({
      cases,
      getCandidates: async (query: string) => {
        const res = await resolveSkill({ query, forceLexical: false });
        if (res.outcome === "matched") {
          return [{ skill_id: res.skill_id, text: `${res.title} ${res.body}` }];
        }
        if (res.outcome === "ambiguous") {
          return res.candidates.map((c) => ({ skill_id: c.skill_id, text: `${c.title} ${c.description}` }));
        }
        return [];
      },
      reranker: clients.rerank,
    });
    return { result };
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
      await applyCalibrationRun(db, runId, expandHome(this.configPath), {});
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

  async calibrateRun(opts?: { datasetPath?: string }): Promise<{ run_id?: string; result?: CalibrationResult }> {
    const { status, data } = await this.fetchJson("/admin/v1/calibrations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dataset_path: opts?.datasetPath }),
    });
    if (status !== 202) {
      throw new Error(`Remote calibration start failed (${status}): ${data?.message || data}`);
    }
    return data;
  }

  async calibrateList(): Promise<any[]> {
    const { status, data } = await this.fetchJson("/admin/v1/calibrations");
    if (status !== 200) throw new Error(`Remote calibration list failed (${status}): ${data?.message || data}`);
    return data;
  }

  async calibrateShow(runId: string): Promise<any> {
    const { status, data } = await this.fetchJson(`/admin/v1/calibrations/${runId}`);
    if (status !== 200) throw new Error(`Remote calibration show failed (${status}): ${data?.message || data}`);
    return data;
  }

  async calibrateApply(runId: string): Promise<any> {
    const { status, data } = await this.fetchJson(`/admin/v1/calibrations/${runId}/apply`, {
      method: "POST",
    });
    if (status !== 200) throw new Error(`Remote calibration apply failed (${status}): ${data?.message || data}`);
    return data;
  }
}

export function createTargetAdapter(target: ResolvedTarget, opts?: TargetAdapterOptions): TargetAdapter {
  if (target.type === "local") {
    return new LocalAdapter(opts);
  } else {
    return new RemoteAdapter({ server: target.server, token_env: target.token_env }, opts);
  }
}
