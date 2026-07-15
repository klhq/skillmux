import { homedir } from "node:os";
import { join } from "node:path";
import type { Config, ONNXDevice, ONNXDtype } from "./types";

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
    device: "cpu",
    dtype: "q8",
  },
  rerank: {
    base_url: "http://127.0.0.1:7997",
    model: "BAAI/bge-reranker-v2-m3",
    device: "cpu",
    dtype: "q8",
  },
  remote_timeout_ms: 2000,
  server: {
    auth_enabled: false,
    auth_token_env: "SKILL_ROUTER_AUTH_TOKEN",
    allowed_origins: ["*"],
    rate_limit: {
      enabled: false,
      requests_per_minute: 60,
    },
  },
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

  const baseConfig = structuredClone(DEFAULTS);
  if (process.env.RUNNING_IN_DOCKER === "true") {
    baseConfig.vault_path = "/vault";
    baseConfig.state_dir = "/data";
    baseConfig.embedding.base_url = "local://";
    baseConfig.rerank.base_url = "local://";
  }

  let merged: Config;
  if (!(await file.exists())) {
    merged = baseConfig;
  } else {
    const parsed = Bun.TOML.parse(await file.text());
    merged = deepMerge(baseConfig, parsed);
  }

  // Environment variable overrides (AC4)
  if (process.env.VAULT_PATH) {
    merged.vault_path = process.env.VAULT_PATH;
  }
  if (process.env.STATE_DIR) {
    merged.state_dir = process.env.STATE_DIR;
  }
  if (process.env.EMBED_BASE_URL) {
    merged.embedding.base_url = process.env.EMBED_BASE_URL;
  }
  if (process.env.EMBED_DEVICE) {
    merged.embedding.device = process.env.EMBED_DEVICE as ONNXDevice;
  }
  if (process.env.EMBED_DTYPE) {
    merged.embedding.dtype = process.env.EMBED_DTYPE as ONNXDtype;
  }
  if (process.env.RERANK_BASE_URL) {
    merged.rerank.base_url = process.env.RERANK_BASE_URL;
  }
  if (process.env.RERANK_DEVICE) {
    merged.rerank.device = process.env.RERANK_DEVICE as ONNXDevice;
  }
  if (process.env.RERANK_DTYPE) {
    merged.rerank.dtype = process.env.RERANK_DTYPE as ONNXDtype;
  }

  const getEnv = (prefixed: string, unprefixed: string) => process.env[prefixed] || process.env[unprefixed];

  const embedModel = getEnv("SKILL_ROUTER_EMBED_MODEL", "EMBED_MODEL");
  if (embedModel) {
    merged.embedding.model = embedModel;
  }

  const embedDimStr = getEnv("SKILL_ROUTER_EMBED_DIMENSION", "EMBED_DIMENSION");
  if (embedDimStr) {
    const dim = Number(embedDimStr);
    if (!Number.isInteger(dim)) {
      throw new Error(`Invalid embedding dimension: ${embedDimStr}`);
    }
    merged.embedding.dimension = dim;
  }

  const rerankModel = getEnv("SKILL_ROUTER_RERANK_MODEL", "RERANK_MODEL");
  if (rerankModel) {
    merged.rerank.model = rerankModel;
  }

  // HTTP server environment overrides
  if (merged.server) {
    if (process.env.HTTP_AUTH_ENABLED) {
      merged.server.auth_enabled = process.env.HTTP_AUTH_ENABLED === "true";
    }
    if (process.env.HTTP_AUTH_TOKEN_ENV) {
      merged.server.auth_token_env = process.env.HTTP_AUTH_TOKEN_ENV;
    }
    if (process.env.HTTP_ALLOWED_ORIGINS) {
      merged.server.allowed_origins = process.env.HTTP_ALLOWED_ORIGINS.split(",").map((o) => o.trim());
    }

    if (!merged.server.rate_limit) {
      merged.server.rate_limit = { enabled: false, requests_per_minute: 60 };
    }

    const rateLimitEnabledStr = getEnv("SKILL_ROUTER_HTTP_RATE_LIMIT_ENABLED", "HTTP_RATE_LIMIT_ENABLED");
    if (rateLimitEnabledStr) {
      merged.server.rate_limit.enabled = rateLimitEnabledStr === "true";
    }

    const rateLimitRPMStr = getEnv("SKILL_ROUTER_HTTP_RATE_LIMIT_RPM", "HTTP_RATE_LIMIT_RPM");
    if (rateLimitRPMStr) {
      const rpm = Number(rateLimitRPMStr);
      if (!Number.isInteger(rpm)) {
        throw new Error(`Invalid rate limit RPM: ${rateLimitRPMStr}`);
      }
      merged.server.rate_limit.requests_per_minute = rpm;
    }

    if (merged.server.rate_limit.enabled && merged.server.rate_limit.requests_per_minute === undefined) {
      merged.server.rate_limit.requests_per_minute = 60;
    }
  }

  return merged;
}
