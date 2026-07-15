import { homedir } from "node:os";
import { join } from "node:path";
import type { Config } from "./types";

// Fallback values only; a config.toml (SKILL_ROUTER_CONFIG or default path)
// overrides them. Endpoints default to localhost placeholders — deployment-
// specific hosts belong in the user's config.toml, never in code. Threshold
// values are pre-calibration placeholders — the eval harness (AC11) produces
// the real ones.
const DEFAULTS: Config = {
  vault_path: "~/.agents/skills",
  state_dir: "~/.local/state/skill-router",
  recall: { k_lexical: 15, k_vector: 15 },
  thresholds: { match_score: 0.9, match_margin: 0.3, candidate_floor: 0.5, candidate_limit: 5 },
  embedding: {
    base_url: "http://127.0.0.1:8080",
    api_key_env: "SKILL_ROUTER_EMBED_KEY",
    model: "microsoft/harrier-oss-v1-0.6b",
    dimension: 1024,
  },
  rerank: {
    base_url: "http://127.0.0.1:7997",
    model: "BAAI/bge-reranker-v2-m3",
  },
  remote_timeout_ms: 2000,
};

export const DEFAULT_CONFIG_PATH = "~/.config/skill-router/config.toml";

export function expandHome(path: string): string {
  return path.startsWith("~") ? join(homedir(), path.slice(1)) : path;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMerge<T>(base: T, override: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return (override === undefined ? base : override) as T;
  }
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    out[key] = deepMerge((base as Record<string, unknown>)[key], value);
  }
  return out as T;
}

export async function loadConfig(path?: string): Promise<Config> {
  const configPath = path ?? process.env.SKILL_ROUTER_CONFIG ?? DEFAULT_CONFIG_PATH;
  const file = Bun.file(expandHome(configPath));
  if (!(await file.exists())) return structuredClone(DEFAULTS);
  const parsed = Bun.TOML.parse(await file.text());
  return deepMerge(structuredClone(DEFAULTS), parsed);
}
