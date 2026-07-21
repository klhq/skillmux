import { existsSync, mkdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { Config, ONNXDevice, ONNXDtype } from "./types";

const onnxDeviceSchema = z.enum([
  "cpu", "auto", "gpu", "wasm", "webgpu", "cuda", "dml", "coreml",
  "webnn", "webnn-npu", "webnn-gpu", "webnn-cpu",
]);
const onnxDtypeSchema = z.enum([
  "q8", "auto", "fp32", "fp16", "int8", "uint8", "q4", "bnb4", "q4f16",
  "q2", "q2f16", "q1", "q1f16",
]);

const modelSchema = z.object({
  model: z.string().min(1),
  device: onnxDeviceSchema.optional(),
  dtype: onnxDtypeSchema.optional(),
}).strict();

const remoteThresholdsSchema = z.object({
  match_score: z.number(),
  match_margin: z.number().nonnegative(),
  candidate_floor: z.number(),
}).strict();

const configSchema = z.object({
  vault_path: z.string().min(1),
  state_dir: z.string().min(1),
  recall: z.object({ k_lexical: z.number().int().positive(), k_vector: z.number().int().positive() }).strict(),
  thresholds: z.object({
    candidate_limit: z.number().int().positive(),
    match_score: z.number().optional(),
    match_margin: z.number().nonnegative().optional(),
    candidate_floor: z.number().optional(),
  }).strict(),
  inference: z.discriminatedUnion("mode", [
    z.object({
      mode: z.literal("local"),
      bundle: z.string().min(1),
      models_dir: z.string().min(1),
      embedding: modelSchema.extend({ dimension: z.number().int().positive() }),
    }).strict(),
    z.object({
      mode: z.literal("remote"),
      timeout_ms: z.number().int().min(100),
      embedding: z.object({
        provider: z.literal("openai"),
        base_url: z.url(),
        model: z.string().min(1),
        dimension: z.number().int().positive(),
        api_key_env: z.string().min(1).optional(),
      }).strict(),
      reranker: z.object({
        provider: z.literal("infinity"),
        base_url: z.url(),
        model: z.string().min(1),
        api_key_env: z.string().min(1).optional(),
      }).strict().optional(),
      thresholds: remoteThresholdsSchema.optional(),
    }).strict(),
  ]),
  server: z.object({
    auth_enabled: z.boolean(),
    auth_token_env: z.string().min(1),
    allowed_origins: z.array(z.string()),
    hostname: z.string().min(1).optional(),
    rate_limit: z.object({
      enabled: z.boolean(),
      requests_per_minute: z.number().int().positive(),
      trust_proxy: z.boolean().optional(),
    }).strict().optional(),
  }).strict().optional(),
}).strict();

// Fallback values only; a config.toml (SKILLMUX_CONFIG or default path)
// overrides them. The local bundle is the zero-config OSS path.
export const LOCAL_BUNDLE_ID = "gte-small-v1";

const DEFAULTS: Config = {
  vault_path: "~/skills",
  state_dir: "~/.local/state/skillmux",
  recall: { k_lexical: 20, k_vector: 20 },
  thresholds: { candidate_limit: 5 },
  inference: {
    mode: "local",
    bundle: LOCAL_BUNDLE_ID,
    models_dir: "~/.cache/skillmux/models",
    embedding: {
      model: "Xenova/gte-small",
      dimension: 384,
      device: "cpu",
      dtype: "q8",
    },
  },
  server: {
    auth_enabled: false,
    auth_token_env: "SKILLMUX_AUTH_TOKEN",
    // Deny-by-default CORS: only requests that send no Origin header (curl,
    // MCP clients, server-to-server) pass; browser-issued cross-origin
    // requests are rejected until an origin is explicitly allow-listed.
    allowed_origins: [],
    // Loopback-only by default so a zero-config `skillmux serve --transport http`
    // isn't reachable from the network. Docker overrides this to 0.0.0.0
    // below since the container's own loopback isn't reachable through
    // port-mapping.
    hostname: "127.0.0.1",
    rate_limit: {
      enabled: false,
      requests_per_minute: 60,
    },
  },
};

export const DEFAULT_CONFIG_PATH = "~/.config/skillmux/config.toml";

export function embeddingDimension(config: Config): number {
  return config.inference.embedding.dimension;
}

export function embeddingFingerprint(config: Config): string {
  const inference = config.inference;
  const implementation =
    inference.mode === "local" ? `local:${inference.bundle}` : `remote:${inference.embedding.provider}`;
  return `${implementation}:${inference.embedding.model}:${inference.embedding.dimension}`;
}

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


function migrateLegacyDir(legacy: string, next: string): void {
  const legacyPath = expandHome(legacy);
  const nextPath = expandHome(next);
  if (existsSync(nextPath) || !existsSync(legacyPath)) return;
  mkdirSync(dirname(nextPath), { recursive: true });
  renameSync(legacyPath, nextPath);
  console.error(`skillmux: migrated ${legacyPath} -> ${nextPath}`);
}

export function migrateLegacyPaths(): void {
  migrateLegacyDir("~/.config/skill-router", "~/.config/skillmux");
  migrateLegacyDir("~/.local/state/skill-router", "~/.local/state/skillmux");
  migrateLegacyDir("~/.cache/skill-router", "~/.cache/skillmux");
}

export async function loadConfig(path?: string): Promise<Config> {
  migrateLegacyPaths();
  const configEnv = process.env.SKILLMUX_CONFIG;
  const configPath = path ?? configEnv ?? DEFAULT_CONFIG_PATH;
  const file = Bun.file(expandHome(configPath));

  const baseConfig = structuredClone(DEFAULTS);
  if (process.env.RUNNING_IN_DOCKER === "true") {
    baseConfig.vault_path = "/vault";
    baseConfig.state_dir = "/data";
    if (baseConfig.inference.mode === "local") baseConfig.inference.models_dir = "/models";
    if (baseConfig.server) baseConfig.server.hostname = "0.0.0.0";
  }

  let merged: Config;
  if (!(await file.exists())) {
    merged = baseConfig;
  } else {
    const parsed = Bun.TOML.parse(await file.text()) as Record<string, unknown>;
    if ("embedding" in parsed || "rerank" in parsed || "remote_timeout_ms" in parsed) {
      throw new Error(
        "Legacy inference config is not supported. Move [embedding], [rerank], and remote_timeout_ms under [inference] using config.remote.example.toml.",
      );
    }
    if (isPlainObject(parsed.inference) && parsed.inference.mode === "remote") {
      if (!isPlainObject(parsed.inference.embedding)) {
        throw new Error("Remote inference requires an inference.embedding section.");
      }
      const withoutInference = { ...parsed };
      delete withoutInference.inference;
      merged = {
        ...deepMerge(baseConfig, withoutInference),
        inference: configSchema.shape.inference.parse(parsed.inference),
      };
    } else {
      merged = deepMerge(baseConfig, parsed);
    }
  }

  // Environment variable overrides.
  if (process.env.VAULT_PATH) {
    merged.vault_path = process.env.VAULT_PATH;
  }
  if (process.env.STATE_DIR) {
    merged.state_dir = process.env.STATE_DIR;
  }
  const getEnv = (newPrefixed: string, unprefixed: string) => {
    return process.env[newPrefixed] ?? process.env[unprefixed];
  };

  if (merged.inference.mode === "local") {
    const modelsDirEnv = process.env.SKILLMUX_MODELS_DIR;
    if (modelsDirEnv) merged.inference.models_dir = modelsDirEnv;
    if (process.env.EMBED_DEVICE) merged.inference.embedding.device = process.env.EMBED_DEVICE as ONNXDevice;
    if (process.env.EMBED_DTYPE) merged.inference.embedding.dtype = process.env.EMBED_DTYPE as ONNXDtype;
  } else if (merged.inference.mode === "remote") {
    if (!merged.inference.embedding) {
      throw new Error("Remote inference requires an inference.embedding section.");
    }
    if (merged.inference.embedding?.provider !== "openai") {
      throw new Error('Remote inference.embedding.provider must be "openai".');
    }
    if (merged.inference.reranker && merged.inference.reranker.provider !== "infinity") {
      throw new Error('Remote inference.reranker.provider must be "infinity".');
    }
    if (!Number.isInteger(merged.inference.timeout_ms) || merged.inference.timeout_ms < 100) {
      throw new Error("Remote inference.timeout_ms must be an integer of at least 100.");
    }
    if (!merged.inference.embedding?.base_url || !merged.inference.embedding.model || !merged.inference.embedding.dimension) {
      throw new Error("Remote inference requires inference.embedding base_url, model, and dimension.");
    }
    if (merged.inference.reranker && (!merged.inference.reranker.base_url || !merged.inference.reranker.model)) {
      throw new Error("Configured inference.reranker requires base_url and model.");
    }
    if (merged.inference.reranker && !merged.inference.thresholds) {
      throw new Error("Configured inference.reranker requires calibrated inference.thresholds.");
    }
    for (const [name, value] of [
      ["inference.embedding.base_url", merged.inference.embedding.base_url],
      ...(merged.inference.reranker ? [["inference.reranker.base_url", merged.inference.reranker.base_url] as const] : []),
    ] as const) {
      try {
        const url = new URL(value);
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
      } catch {
        throw new Error(`${name} must be an HTTP(S) URL.`);
      }
    }
    const embedUrl = getEnv("SKILLMUX_EMBED_BASE_URL", "EMBED_BASE_URL");
    const embedModel = getEnv("SKILLMUX_EMBED_MODEL", "EMBED_MODEL");
    const embedDimStr = getEnv("SKILLMUX_EMBED_DIMENSION", "EMBED_DIMENSION");
    const rerankUrl = getEnv("SKILLMUX_RERANK_BASE_URL", "RERANK_BASE_URL");
    const rerankModel = getEnv("SKILLMUX_RERANK_MODEL", "RERANK_MODEL");
    if (embedUrl) merged.inference.embedding.base_url = embedUrl;
    if (embedModel) merged.inference.embedding.model = embedModel;
    if (rerankUrl && merged.inference.reranker) merged.inference.reranker.base_url = rerankUrl;
    if (rerankModel && merged.inference.reranker) merged.inference.reranker.model = rerankModel;
    if (embedDimStr) {
      const dimension = Number(embedDimStr);
      if (!Number.isInteger(dimension) || dimension < 1) throw new Error(`Invalid embedding dimension: ${embedDimStr}`);
      merged.inference.embedding.dimension = dimension;
    }
  } else {
    throw new Error(`Invalid inference.mode: ${(merged.inference as { mode?: unknown }).mode}`);
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
    if (process.env.HTTP_HOSTNAME) {
      merged.server.hostname = process.env.HTTP_HOSTNAME;
    }

    if (!merged.server.rate_limit) {
      merged.server.rate_limit = { enabled: false, requests_per_minute: 60 };
    }

    const rateLimitEnabledStr = getEnv("SKILLMUX_HTTP_RATE_LIMIT_ENABLED", "HTTP_RATE_LIMIT_ENABLED");
    if (rateLimitEnabledStr) {
      merged.server.rate_limit.enabled = rateLimitEnabledStr === "true";
    }

    const rateLimitRPMStr = getEnv("SKILLMUX_HTTP_RATE_LIMIT_RPM", "HTTP_RATE_LIMIT_RPM");
    if (rateLimitRPMStr) {
      const rpm = Number(rateLimitRPMStr);
      if (!Number.isInteger(rpm)) {
        throw new Error(`Invalid rate limit RPM: ${rateLimitRPMStr}`);
      }
      merged.server.rate_limit.requests_per_minute = rpm;
    }

    const rateLimitTrustProxyStr = getEnv("SKILLMUX_HTTP_RATE_LIMIT_TRUST_PROXY", "HTTP_RATE_LIMIT_TRUST_PROXY");
    if (rateLimitTrustProxyStr) {
      merged.server.rate_limit.trust_proxy = rateLimitTrustProxyStr === "true";
    }

    if (merged.server.rate_limit.enabled && merged.server.rate_limit.requests_per_minute === undefined) {
      merged.server.rate_limit.requests_per_minute = 60;
    }
  }

  return configSchema.parse(merged) as Config;
}
