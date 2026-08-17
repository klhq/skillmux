import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULT_CONFIG_PATH, expandHome, loadConfig } from "./config";
import { describeDeployment } from "./deployment";
import type { Config } from "./types";

export type ConfigSource = "default" | "toml" | "environment";
export type ConfigSourceMap = Record<string, ConfigSource>;

export interface SetConfigResult {
  ok: boolean;
  key: string;
  prior_val: unknown;
  resulting_val: unknown;
  target: string;
  prior_revision: string;
  resulting_revision: string;
  persistence: "persisted" | "not_persisted" | "failed";
  application: "activated" | "restart_required" | "failed";
  readiness: { status: "ready" | "degraded" | "not_ready" | "stopping"; capability: string };
  restart_required_keys: string[];
}

export interface ConfigStatusResponse {
  target: string;
  desired_source: string;
  desired_source_hash: string;
  active_revision: string;
  active_source_hash: string;
  last_successful_reload_at: string | null;
  last_reload_error: string | null;
  readiness: { status: "ready" | "degraded" | "not_ready" | "stopping"; capability: string };
  restart_required_keys: string[];
  runtime: "running" | "not_running";
  version: string;
  deployment_runtime: "host" | "docker";
  image_variant: "full" | "slim" | null;
}

export const RESTART_REQUIRED_KEYS = [
  "server.hostname",
  "server.auth_enabled",
  "server.auth_token_env",
  "server.admin.enabled",
  "server.admin.token_env",
  "inference.mode",
  "inference.bundle",
  "inference.models_dir",
  "state_dir",
  "inference.embedding.model",
  "inference.embedding.dimension",
  "inference.embedding.device",
  "inference.embedding.dtype",
];

export const RELOADABLE_KEYS = [
  "config.environment_overrides",
  "vault_path",
  "recall.k_lexical",
  "recall.k_vector",
  "recall.k_rerank",
  "output.ambiguous_candidate_limit",
  "thresholds.candidate_limit",
  "thresholds.match_score",
  "thresholds.match_margin",
  "thresholds.candidate_floor",
  "inference.embedding.endpoint",
  "inference.embedding.api_key_env",
  "inference.reranker.adapter",
  "inference.reranker.endpoint",
  "inference.reranker.model",
  "inference.reranker.api_key_env",
  "inference.timeout_ms",
  "server.rate_limit.enabled",
  "server.rate_limit.requests_per_minute",
  "server.rate_limit.trust_proxy",
];

export function getNestedValue(obj: Record<string, any>, path: string): unknown {
  const parts = path.split(".");
  let cur = obj;
  for (const part of parts) {
    if (cur === undefined || cur === null || typeof cur !== "object") return undefined;
    cur = cur[part];
  }
  return cur;
}

export function setNestedValue(obj: Record<string, any>, path: string, value: unknown): void {
  const parts = path.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!;
    if (!cur[part] || typeof cur[part] !== "object") {
      cur[part] = {};
    }
    cur = cur[part];
  }
  const lastPart = parts[parts.length - 1]!;
  cur[lastPart] = value;
}

export function deleteNestedValue(obj: Record<string, any>, path: string): void {
  const parts = path.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!;
    if (!cur[part]) return;
    cur = cur[part];
  }
  const lastPart = parts[parts.length - 1]!;
  delete cur[lastPart];
}

export function computeHash(data: unknown): string {
  const str = typeof data === "string" ? data : JSON.stringify(data);
  return createHash("sha256").update(str).digest("hex").slice(0, 16);
}

export async function getEffectiveConfig(configPath?: string): Promise<{
  effective: Config;
  sources: ConfigSourceMap;
  rawToml: Record<string, unknown>;
}> {
  const path = configPath ?? DEFAULT_CONFIG_PATH;
  const effective = await loadConfig(path);
  const rawToml: Record<string, unknown> = {};

  const fullPath = expandHome(path);
  if (existsSync(fullPath)) {
    try {
      const text = await Bun.file(fullPath).text();
      const parsed = Bun.TOML.parse(text);
      if (typeof parsed === "object" && parsed !== null) {
        Object.assign(rawToml, parsed);
      }
    } catch {
      // empty if unparseable
    }
  }

  const sources: ConfigSourceMap = {};
  const allowEnvOverrides = effective.config?.environment_overrides !== false;

  const allKeys = [
    "config.environment_overrides",
    "vault_path",
    "state_dir",
    "recall.k_lexical",
    "recall.k_vector",
    "recall.k_rerank",
    "output.ambiguous_candidate_limit",
    "thresholds.candidate_limit",
    "thresholds.match_score",
    "thresholds.match_margin",
    "thresholds.candidate_floor",
    "inference.mode",
    "inference.bundle",
    "inference.models_dir",
    "inference.embedding.model",
    "inference.embedding.dimension",
    "inference.embedding.device",
    "inference.embedding.dtype",
    "inference.embedding.endpoint",
    "inference.embedding.api_key_env",
    "inference.reranker.adapter",
    "inference.reranker.endpoint",
    "inference.reranker.model",
    "inference.reranker.api_key_env",
    "inference.timeout_ms",
    "server.auth_enabled",
    "server.auth_token_env",
    "server.admin.enabled",
    "server.admin.token_env",
    "server.hostname",
    "server.rate_limit.enabled",
    "server.rate_limit.requests_per_minute",
    "server.rate_limit.trust_proxy",
  ];

  for (const key of allKeys) {
    if (isEnvMasked(key, allowEnvOverrides)) {
      sources[key] = "environment";
    } else if (getNestedValue(rawToml, key) !== undefined) {
      sources[key] = "toml";
    } else {
      sources[key] = "default";
    }
  }

  return { effective, sources, rawToml };
}

export function isEnvMasked(key: string, allowEnvOverrides: boolean = true): boolean {
  if (!allowEnvOverrides) return false;
  if (key === "vault_path" && (process.env.SKILLMUX_VAULT_PATH || process.env.SKILL_ROUTER_VAULT_PATH || process.env.VAULT_PATH)) return true;
  if (key === "state_dir" && (process.env.SKILLMUX_STATE_DIR || process.env.SKILL_ROUTER_STATE_DIR || process.env.STATE_DIR)) return true;
  if (key === "recall.k_lexical" && (process.env.SKILLMUX_RECALL_K_LEXICAL || process.env.RECALL_K_LEXICAL)) return true;
  if (key === "recall.k_vector" && (process.env.SKILLMUX_RECALL_K_VECTOR || process.env.RECALL_K_VECTOR)) return true;
  if (key === "recall.k_rerank" && (process.env.SKILLMUX_RECALL_K_RERANK || process.env.RECALL_K_RERANK)) return true;
  if (
    (key === "output.ambiguous_candidate_limit" || key === "thresholds.candidate_limit") &&
    (process.env.SKILLMUX_OUTPUT_AMBIGUOUS_CANDIDATE_LIMIT ||
      process.env.AMBIGUOUS_CANDIDATE_LIMIT ||
      process.env.SKILLMUX_CANDIDATE_LIMIT ||
      process.env.CANDIDATE_LIMIT)
  ) {
    return true;
  }
  if (key === "inference.models_dir" && (process.env.SKILLMUX_MODELS_DIR || process.env.SKILL_ROUTER_MODELS_DIR)) return true;
  if (key === "inference.embedding.device" && (process.env.SKILLMUX_EMBED_DEVICE || process.env.EMBED_DEVICE)) return true;
  if (key === "inference.embedding.dtype" && (process.env.SKILLMUX_EMBED_DTYPE || process.env.EMBED_DTYPE)) return true;
  if (key === "inference.embedding.endpoint" && (process.env.SKILLMUX_EMBED_ENDPOINT || process.env.SKILL_ROUTER_EMBED_ENDPOINT || process.env.EMBED_ENDPOINT)) return true;
  if (key === "inference.embedding.model" && (process.env.SKILLMUX_EMBED_MODEL || process.env.SKILL_ROUTER_EMBED_MODEL || process.env.EMBED_MODEL)) return true;
  if (key === "inference.embedding.dimension" && (process.env.SKILLMUX_EMBED_DIMENSION || process.env.SKILL_ROUTER_EMBED_DIMENSION || process.env.EMBED_DIMENSION)) return true;
  if (key === "inference.reranker.adapter" && (process.env.SKILLMUX_RERANK_ADAPTER || process.env.SKILL_ROUTER_RERANK_ADAPTER || process.env.RERANK_ADAPTER)) return true;
  if (key === "inference.reranker.endpoint" && (process.env.SKILLMUX_RERANK_ENDPOINT || process.env.SKILL_ROUTER_RERANK_ENDPOINT || process.env.RERANK_ENDPOINT)) return true;
  if (key === "inference.reranker.model" && (process.env.SKILLMUX_RERANK_MODEL || process.env.SKILL_ROUTER_RERANK_MODEL || process.env.RERANK_MODEL)) return true;
  if (key === "server.auth_enabled" && (process.env.SKILLMUX_HTTP_AUTH_ENABLED || process.env.HTTP_AUTH_ENABLED)) return true;
  if (key === "server.auth_token_env" && (process.env.SKILLMUX_HTTP_AUTH_TOKEN_ENV || process.env.HTTP_AUTH_TOKEN_ENV)) return true;
  if (key === "server.allowed_origins" && (process.env.SKILLMUX_HTTP_ALLOWED_ORIGINS || process.env.HTTP_ALLOWED_ORIGINS)) return true;
  if (key === "server.hostname" && (process.env.SKILLMUX_HTTP_HOSTNAME || process.env.HTTP_HOSTNAME)) return true;
  if (key === "server.rate_limit.enabled" && (process.env.SKILLMUX_HTTP_RATE_LIMIT_ENABLED || process.env.HTTP_RATE_LIMIT_ENABLED)) return true;
  if (key === "server.rate_limit.requests_per_minute" && (process.env.SKILLMUX_HTTP_RATE_LIMIT_RPM || process.env.HTTP_RATE_LIMIT_RPM)) return true;
  if (key === "server.rate_limit.trust_proxy" && (process.env.SKILLMUX_HTTP_RATE_LIMIT_TRUST_PROXY || process.env.HTTP_RATE_LIMIT_TRUST_PROXY)) return true;
  return false;
}

export function validateDottedKey(key: string): void {
  const allowed = new Set([
    "config.environment_overrides",
    "vault_path",
    "state_dir",
    "recall.k_lexical",
    "recall.k_vector",
    "recall.k_rerank",
    "output.ambiguous_candidate_limit",
    "thresholds.candidate_limit",
    "thresholds.match_score",
    "thresholds.match_margin",
    "thresholds.candidate_floor",
    "inference.mode",
    "inference.bundle",
    "inference.models_dir",
    "inference.embedding.model",
    "inference.embedding.dimension",
    "inference.embedding.device",
    "inference.embedding.dtype",
    "inference.embedding.endpoint",
    "inference.embedding.api_key_env",
    "inference.reranker.adapter",
    "inference.reranker.endpoint",
    "inference.reranker.model",
    "inference.reranker.api_key_env",
    "inference.timeout_ms",
    "server.auth_enabled",
    "server.auth_token_env",
    "server.admin.enabled",
    "server.admin.token_env",
    "server.hostname",
    "server.rate_limit.enabled",
    "server.rate_limit.requests_per_minute",
    "server.rate_limit.trust_proxy",
  ]);
  if (!allowed.has(key)) {
    throw new Error(`Unknown configuration key "${key}"`);
  }
}

export function parseDottedValue(key: string, valueStr: string): unknown {
  if (valueStr === "true") return true;
  if (valueStr === "false") return false;
  if (/^-?\d+$/.test(valueStr)) return parseInt(valueStr, 10);
  if (/^-?\d+\.\d+$/.test(valueStr)) return parseFloat(valueStr);

  const numberKeys = new Set([
    "recall.k_lexical",
    "recall.k_vector",
    "recall.k_rerank",
    "output.ambiguous_candidate_limit",
    "thresholds.candidate_limit",
    "thresholds.match_score",
    "thresholds.match_margin",
    "thresholds.candidate_floor",
    "inference.embedding.dimension",
    "inference.timeout_ms",
    "server.rate_limit.requests_per_minute",
  ]);

  if (numberKeys.has(key)) {
    const num = Number(valueStr);
    if (isNaN(num)) {
      throw new Error(`Key "${key}" expects a numeric value, got "${valueStr}"`);
    }
    return num;
  }

  const booleanKeys = new Set([
    "config.environment_overrides",
    "server.auth_enabled",
    "server.admin.enabled",
    "server.rate_limit.enabled",
    "server.rate_limit.trust_proxy",
  ]);

  if (booleanKeys.has(key)) {
    throw new Error(`Key "${key}" expects a boolean value ("true" or "false"), got "${valueStr}"`);
  }

  return valueStr;
}

export async function getDottedKey(key: string, configPath?: string): Promise<unknown> {
  validateDottedKey(key);
  const { effective } = await getEffectiveConfig(configPath);
  return getNestedValue(effective as Record<string, any>, key);
}

export async function setDottedKey(
  key: string,
  rawValStr: string,
  opts?: { configPath?: string; dryRun?: boolean; targetName?: string }
): Promise<SetConfigResult> {
  validateDottedKey(key);
  if (isEnvMasked(key)) {
    throw new Error(`Cannot set environment-masked configuration key "${key}"`);
  }

  const path = opts?.configPath ?? DEFAULT_CONFIG_PATH;
  const targetName = opts?.targetName ?? "local";

  const { effective: priorEffective, rawToml } = await getEffectiveConfig(path);
  const priorVal = getNestedValue(priorEffective as Record<string, any>, key);
  const parsedVal = parseDottedValue(key, rawValStr);

  const updatedToml = structuredClone(rawToml);
  setNestedValue(updatedToml, key, parsedVal);

  const priorRevision = computeHash(priorEffective);

  let resultingRevision = priorRevision;
  let persistence: "persisted" | "not_persisted" | "failed" = "not_persisted";

  if (!opts?.dryRun) {
    const fullPath = expandHome(path);
    const dir = dirname(fullPath);
    mkdirSync(dir, { recursive: true });

    let existingMode = 0o644;
    if (existsSync(fullPath)) {
      try {
        existingMode = statSync(fullPath).mode;
      } catch {
        // default
      }
    }

    const tmpPath = join(dir, `.config-${Math.random().toString(36).slice(2)}.tmp`);
    const newTomlText = stringifyToml(updatedToml);
    writeFileSync(tmpPath, newTomlText, { mode: existingMode, encoding: "utf-8" });
    renameSync(tmpPath, fullPath);

    persistence = "persisted";

    const { effective: newEffective } = await getEffectiveConfig(path);
    resultingRevision = computeHash(newEffective);
  }

  const isRestartRequired = RESTART_REQUIRED_KEYS.some((k) => key === k || key.startsWith(k + "."));
  const application = isRestartRequired ? "restart_required" : "activated";

  return {
    ok: true,
    key,
    prior_val: priorVal,
    resulting_val: parsedVal,
    target: targetName,
    prior_revision: priorRevision,
    resulting_revision: resultingRevision,
    persistence,
    application,
    readiness: { status: "ready", capability: "hybrid" },
    restart_required_keys: isRestartRequired ? [key] : [],
  };
}

export function stringifyToml(obj: Record<string, any>): string {
  let out = "";
  const topLevel: Record<string, any> = {};
  const sections: Record<string, any> = {};

  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "object" && v !== null && !Array.isArray(v)) {
      sections[k] = v;
    } else {
      topLevel[k] = v;
    }
  }

  for (const [k, v] of Object.entries(topLevel)) {
    out += `${k} = ${formatTomlVal(v)}\n`;
  }
  if (Object.keys(topLevel).length > 0) out += "\n";

  for (const [secName, secObj] of Object.entries(sections)) {
    out += stringifyTomlSection([secName], secObj);
  }

  return out;
}

function stringifyTomlSection(path: string[], obj: Record<string, any>): string {
  let out = `[${path.join(".")}]\n`;
  const subSections: Record<string, any> = {};

  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "object" && v !== null && !Array.isArray(v)) {
      subSections[k] = v;
    } else {
      out += `${k} = ${formatTomlVal(v)}\n`;
    }
  }
  out += "\n";

  for (const [subName, subObj] of Object.entries(subSections)) {
    out += stringifyTomlSection([...path, subName], subObj);
  }

  return out;
}

function formatTomlVal(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  if (Array.isArray(v)) return JSON.stringify(v);
  return JSON.stringify(v);
}

export async function getLocalConfigStatus(configPath?: string): Promise<ConfigStatusResponse> {
  const { effective } = await getEffectiveConfig(configPath);
  const hash = computeHash(effective);
  const deployment = describeDeployment(effective);

  return {
    target: "local",
    desired_source: configPath ?? DEFAULT_CONFIG_PATH,
    desired_source_hash: hash,
    active_revision: hash,
    active_source_hash: hash,
    last_successful_reload_at: new Date().toISOString(),
    last_reload_error: null,
    readiness: { status: "ready", capability: "hybrid" },
    restart_required_keys: [],
    runtime: "not_running",
    version: deployment.version,
    deployment_runtime: deployment.runtime,
    image_variant: deployment.image_variant,
  };
}
