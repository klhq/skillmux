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
  config: z.object({
    environment_overrides: z.boolean().default(true),
  }).strict().optional(),
  vault_path: z.string().min(1),
  local_vault_paths: z.array(z.string()),
  state_dir: z.string().min(1),
  recall: z.object({
    k_lexical: z.number().int().positive(),
    k_vector: z.number().int().positive(),
    k_rerank: z.number().int().positive().optional(),
  }).strict().transform((r) => ({
    ...r,
    k_rerank: r.k_rerank ?? Math.min(10, r.k_lexical + r.k_vector),
  })).refine((r) => r.k_rerank <= r.k_lexical + r.k_vector, {
    message: "recall.k_rerank cannot exceed k_lexical + k_vector",
  }),
  output: z.object({
    top_k: z.number().int().positive().default(10),
    max_top_k: z.number().int().positive().default(50),
  }).strict().refine((o) => o.top_k <= o.max_top_k, {
    message: "output.top_k cannot exceed output.max_top_k",
  }).default({ top_k: 10, max_top_k: 50 }),
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
        endpoint: z.url(),
        model: z.string().min(1),
        dimension: z.number().int().positive(),
        api_key_env: z.string().min(1).optional(),
      }).strict(),
      reranker: z.object({
        adapter: z.enum(["jina-v1", "bifrost-v1"]),
        endpoint: z.url(),
        model: z.string().min(1),
        api_key_env: z.string().min(1).optional(),
      }).strict().optional(),
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
    admin: z.object({
      enabled: z.boolean(),
      token_env: z.string().min(1),
    }).strict().optional(),
  }).strict().optional(),
}).strict().refine((cfg) => {
  const hasReranker = cfg.inference.mode === "remote" && !!cfg.inference.reranker;
  if (hasReranker && cfg.output.max_top_k > cfg.recall.k_rerank) {
    return false;
  }
  return true;
}, {
  message: "output.max_top_k cannot exceed recall.k_rerank when reranking is enabled",
});

// Fallback values only; a config.toml (SKILLMUX_CONFIG or default path)
// overrides them. The local bundle is the zero-config OSS path.
export const LOCAL_BUNDLE_ID = "gte-small-v1";

const DEFAULTS: Config = {
  config: {
    environment_overrides: true,
  },
  vault_path: "~/skills",
  local_vault_paths: [],
  state_dir: "~/.local/state/skillmux",
  recall: { k_lexical: 20, k_vector: 20, k_rerank: 10 },
  output: { top_k: 10, max_top_k: 50 },
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

export function rerankerFingerprint(config: Config): string | undefined {
  const inference = config.inference;
  if (inference.mode !== "remote" || !inference.reranker) return undefined;
  return `remote:${inference.reranker.adapter}:${inference.reranker.model}`;
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

export const warnedEnv = new Set<string>();

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

export function resolveConfigPath(path?: string): string {
  let configEnv = process.env.SKILLMUX_CONFIG;
  if (configEnv === undefined && process.env.SKILL_ROUTER_CONFIG !== undefined) {
    if (!warnedEnv.has("SKILL_ROUTER_CONFIG")) {
      warnedEnv.add("SKILL_ROUTER_CONFIG");
      console.error("skillmux: SKILL_ROUTER_CONFIG is deprecated, use SKILLMUX_CONFIG instead");
    }
    configEnv = process.env.SKILL_ROUTER_CONFIG;
  }
  return expandHome(path ?? configEnv ?? DEFAULT_CONFIG_PATH);
}

export async function loadConfig(path?: string): Promise<Config> {
  migrateLegacyPaths();
  const removedRerankerEnv = [
    "SKILLMUX_RERANK_BASE_URL",
    "SKILL_ROUTER_RERANK_BASE_URL",
    "RERANK_BASE_URL",
  ].find((name) => process.env[name] !== undefined);
  if (removedRerankerEnv) {
    throw new Error(
      `${removedRerankerEnv} is no longer supported. Configure ` +
        "inference.reranker.endpoint with the complete request URL and " +
        'inference.reranker.adapter (for example, "jina-v1"). The old client appended /rerank.',
    );
  }
  const removedEmbeddingEnv = [
    "SKILLMUX_EMBED_BASE_URL",
    "SKILL_ROUTER_EMBED_BASE_URL",
    "EMBED_BASE_URL",
  ].find((name) => process.env[name] !== undefined);
  if (removedEmbeddingEnv) {
    throw new Error(
      `${removedEmbeddingEnv} is no longer supported. Configure ` +
        "inference.embedding.endpoint with the complete OpenAI-compatible embeddings request URL. " +
        "The old client appended /v1/embeddings.",
    );
  }
  const removedLegacyOutputEnv = [
    "SKILLMUX_OUTPUT_AMBIGUOUS_CANDIDATE_LIMIT",
    "AMBIGUOUS_CANDIDATE_LIMIT",
    "SKILLMUX_CANDIDATE_LIMIT",
    "CANDIDATE_LIMIT",
  ].find((name) => process.env[name] !== undefined);
  if (removedLegacyOutputEnv) {
    throw new Error(
      `${removedLegacyOutputEnv} is no longer supported. Use SKILLMUX_OUTPUT_TOP_K instead.`,
    );
  }

  const configPath = resolveConfigPath(path);
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
    if ("thresholds" in parsed) {
      throw new Error(
        "The [thresholds] table is obsolete. Threshold calibration was removed; use [output] with top_k.",
      );
    }
    if (isPlainObject(parsed.output) && "ambiguous_candidate_limit" in parsed.output) {
      throw new Error(
        "output.ambiguous_candidate_limit is obsolete. Use output.top_k instead.",
      );
    }
    if (isPlainObject(parsed.inference) && "thresholds" in parsed.inference) {
      throw new Error(
        "inference.thresholds is obsolete. Threshold calibration was removed.",
      );
    }
    if (isPlainObject(parsed.inference) && "calibration" in parsed.inference) {
      throw new Error(
        "inference.calibration is obsolete and should be deleted. Threshold calibration was removed; use skillmux eval for ranking evaluation.",
      );
    }
    if ("embedding" in parsed || "rerank" in parsed || "remote_timeout_ms" in parsed) {
      throw new Error(
        "Legacy inference config is not supported. Move [embedding], [rerank], and remote_timeout_ms under [inference] using config.remote.example.toml.",
      );
    }
    const rawReranker = isPlainObject(parsed.inference)
      ? parsed.inference.reranker
      : undefined;
    const rawEmbedding = isPlainObject(parsed.inference)
      ? parsed.inference.embedding
      : undefined;
    if (
      isPlainObject(rawReranker) &&
      ("provider" in rawReranker || "base_url" in rawReranker)
    ) {
      throw new Error(
        "inference.reranker.provider and inference.reranker.base_url are no longer supported. " +
          "Use adapter and the complete endpoint URL instead; the old client appended /rerank.",
      );
    }
    if (isPlainObject(rawEmbedding) && "base_url" in rawEmbedding) {
      throw new Error(
        "inference.embedding.base_url is no longer supported. Use inference.embedding.endpoint " +
          "with the complete OpenAI-compatible embeddings request URL; the old client appended /v1/embeddings.",
      );
    }
    if (isPlainObject(parsed.inference) && parsed.inference.mode === "remote") {
      if (!isPlainObject(parsed.inference.embedding)) {
        throw new Error("Remote inference requires an inference.embedding section.");
      }
    }

    if (parsed.inference && typeof parsed.inference === "object" && "mode" in parsed.inference) {
      if (parsed.inference.mode === "remote") {
        const withoutInference = { ...parsed };
        delete withoutInference.inference;
        merged = {
          ...deepMerge(baseConfig, withoutInference),
          inference: configSchema.shape.inference.parse(parsed.inference),
        };
      } else {
        merged = deepMerge(baseConfig, parsed);
      }
    } else {
      merged = deepMerge(baseConfig, parsed);
    }
  }

  if (!merged.output) {
    merged.output = { top_k: 10, max_top_k: 50 };
  }

  // Warn about deprecated generic environment variables regardless of override policy
  const GENERIC_ENV_MAPPINGS: Record<string, string> = {
    VAULT_PATH: "SKILLMUX_VAULT_PATH",
    STATE_DIR: "SKILLMUX_STATE_DIR",
    RECALL_K_LEXICAL: "SKILLMUX_RECALL_K_LEXICAL",
    RECALL_K_VECTOR: "SKILLMUX_RECALL_K_VECTOR",
    RECALL_K_RERANK: "SKILLMUX_RECALL_K_RERANK",
    OUTPUT_TOP_K: "SKILLMUX_OUTPUT_TOP_K",
    OUTPUT_MAX_TOP_K: "SKILLMUX_OUTPUT_MAX_TOP_K",
    EMBED_MODEL: "SKILLMUX_EMBED_MODEL",
    EMBED_ENDPOINT: "SKILLMUX_EMBED_ENDPOINT",
    EMBED_DIMENSION: "SKILLMUX_EMBED_DIMENSION",
    EMBED_DEVICE: "SKILLMUX_EMBED_DEVICE",
    EMBED_DTYPE: "SKILLMUX_EMBED_DTYPE",
    RERANK_MODEL: "SKILLMUX_RERANK_MODEL",
    RERANK_ENDPOINT: "SKILLMUX_RERANK_ENDPOINT",
    RERANK_ADAPTER: "SKILLMUX_RERANK_ADAPTER",
    HTTP_AUTH_ENABLED: "SKILLMUX_HTTP_AUTH_ENABLED",
    HTTP_AUTH_TOKEN_ENV: "SKILLMUX_HTTP_AUTH_TOKEN_ENV",
    HTTP_ALLOWED_ORIGINS: "SKILLMUX_HTTP_ALLOWED_ORIGINS",
    HTTP_HOSTNAME: "SKILLMUX_HTTP_HOSTNAME",
    HTTP_RATE_LIMIT_ENABLED: "SKILLMUX_HTTP_RATE_LIMIT_ENABLED",
    HTTP_RATE_LIMIT_RPM: "SKILLMUX_HTTP_RATE_LIMIT_RPM",
    HTTP_RATE_LIMIT_TRUST_PROXY: "SKILLMUX_HTTP_RATE_LIMIT_TRUST_PROXY",
  };
  for (const [generic, preferred] of Object.entries(GENERIC_ENV_MAPPINGS)) {
    if (process.env[generic] !== undefined && !warnedEnv.has(generic)) {
      warnedEnv.add(generic);
      console.error(`skillmux: ${generic} is deprecated, use ${preferred} instead`);
    }
  }

  const allowEnvOverrides = merged.config?.environment_overrides !== false;

  const getEnv = (newPrefixed: string, unprefixed: string) => {
    if (!allowEnvOverrides) return undefined;
    const legacyPrefixed = newPrefixed.replace(/^SKILLMUX_/, "SKILL_ROUTER_");
    if (process.env[newPrefixed] !== undefined) return process.env[newPrefixed];
    if (process.env[legacyPrefixed] !== undefined) {
      if (!warnedEnv.has(legacyPrefixed)) {
        warnedEnv.add(legacyPrefixed);
        console.error(`skillmux: ${legacyPrefixed} is deprecated, use ${newPrefixed} instead`);
      }
      return process.env[legacyPrefixed];
    }
    return process.env[unprefixed];
  };

  // Environment variable overrides.
  if (allowEnvOverrides) {
    const vaultPath = getEnv("SKILLMUX_VAULT_PATH", "VAULT_PATH");
    if (vaultPath) merged.vault_path = vaultPath;
    const stateDir = getEnv("SKILLMUX_STATE_DIR", "STATE_DIR");
    if (stateDir) merged.state_dir = stateDir;
    const kLexicalStr = getEnv("SKILLMUX_RECALL_K_LEXICAL", "RECALL_K_LEXICAL");
    if (kLexicalStr) {
      const k = Number(kLexicalStr);
      if (!Number.isInteger(k) || k < 1) throw new Error(`Invalid recall.k_lexical: ${kLexicalStr}`);
      merged.recall.k_lexical = k;
    }
    const kVectorStr = getEnv("SKILLMUX_RECALL_K_VECTOR", "RECALL_K_VECTOR");
    if (kVectorStr) {
      const k = Number(kVectorStr);
      if (!Number.isInteger(k) || k < 1) throw new Error(`Invalid recall.k_vector: ${kVectorStr}`);
      merged.recall.k_vector = k;
    }
    const kRerankStr = getEnv("SKILLMUX_RECALL_K_RERANK", "RECALL_K_RERANK");
    if (kRerankStr) {
      const k = Number(kRerankStr);
      if (!Number.isInteger(k) || k < 1) throw new Error(`Invalid recall.k_rerank: ${kRerankStr}`);
      merged.recall.k_rerank = k;
    }
    const topKStr = getEnv("SKILLMUX_OUTPUT_TOP_K", "OUTPUT_TOP_K");
    if (topKStr) {
      const k = Number(topKStr);
      if (!Number.isInteger(k) || k < 1) throw new Error(`Invalid output.top_k: ${topKStr}`);
      merged.output.top_k = k;
    }
    const maxTopKStr = getEnv("SKILLMUX_OUTPUT_MAX_TOP_K", "OUTPUT_MAX_TOP_K");
    if (maxTopKStr) {
      const k = Number(maxTopKStr);
      if (!Number.isInteger(k) || k < 1) throw new Error(`Invalid output.max_top_k: ${maxTopKStr}`);
      merged.output.max_top_k = k;
    }
  }

  if (merged.inference.mode === "local") {
    if (allowEnvOverrides) {
      let modelsDirEnv = process.env.SKILLMUX_MODELS_DIR;
      if (modelsDirEnv === undefined && process.env.SKILL_ROUTER_MODELS_DIR !== undefined) {
        if (!warnedEnv.has("SKILL_ROUTER_MODELS_DIR")) {
          warnedEnv.add("SKILL_ROUTER_MODELS_DIR");
          console.error("skillmux: SKILL_ROUTER_MODELS_DIR is deprecated, use SKILLMUX_MODELS_DIR instead");
        }
        modelsDirEnv = process.env.SKILL_ROUTER_MODELS_DIR;
      }
      if (modelsDirEnv) merged.inference.models_dir = modelsDirEnv;
      const embedDevice = getEnv("SKILLMUX_EMBED_DEVICE", "EMBED_DEVICE");
      if (embedDevice) merged.inference.embedding.device = embedDevice as ONNXDevice;
      const embedDtype = getEnv("SKILLMUX_EMBED_DTYPE", "EMBED_DTYPE");
      if (embedDtype) merged.inference.embedding.dtype = embedDtype as ONNXDtype;
    }
  } else if (merged.inference.mode === "remote") {
    if (!merged.inference.embedding) {
      throw new Error("Remote inference requires an inference.embedding section.");
    }
    if (merged.inference.embedding?.provider !== "openai") {
      throw new Error('Remote inference.embedding.provider must be "openai".');
    }
    if (!Number.isInteger(merged.inference.timeout_ms) || merged.inference.timeout_ms < 100) {
      throw new Error("Remote inference.timeout_ms must be an integer of at least 100.");
    }
    if (!merged.inference.embedding?.endpoint || !merged.inference.embedding.model || !merged.inference.embedding.dimension) {
      throw new Error("Remote inference requires inference.embedding endpoint, model, and dimension.");
    }
    if (merged.inference.reranker && (!merged.inference.reranker.endpoint || !merged.inference.reranker.model)) {
      throw new Error("Configured inference.reranker requires adapter, endpoint, and model.");
    }
    const embedEndpoint = getEnv("SKILLMUX_EMBED_ENDPOINT", "EMBED_ENDPOINT");
    const embedModel = getEnv("SKILLMUX_EMBED_MODEL", "EMBED_MODEL");
    const embedDimStr = getEnv("SKILLMUX_EMBED_DIMENSION", "EMBED_DIMENSION");
    const rerankEndpoint = getEnv("SKILLMUX_RERANK_ENDPOINT", "RERANK_ENDPOINT");
    const rerankAdapter = getEnv("SKILLMUX_RERANK_ADAPTER", "RERANK_ADAPTER");
    const rerankModel = getEnv("SKILLMUX_RERANK_MODEL", "RERANK_MODEL");
    if (embedEndpoint) merged.inference.embedding.endpoint = embedEndpoint;
    if (embedModel) merged.inference.embedding.model = embedModel;
    if (rerankEndpoint && merged.inference.reranker) merged.inference.reranker.endpoint = rerankEndpoint;
    if (rerankAdapter && merged.inference.reranker) {
      merged.inference.reranker.adapter = rerankAdapter as "jina-v1" | "bifrost-v1";
    }
    if (rerankModel && merged.inference.reranker) merged.inference.reranker.model = rerankModel;
    if (embedDimStr) {
      const dimension = Number(embedDimStr);
      if (!Number.isInteger(dimension) || dimension < 1) throw new Error(`Invalid embedding dimension: ${embedDimStr}`);
      merged.inference.embedding.dimension = dimension;
    }
    for (const [name, value, exactEndpoint] of [
      ["inference.embedding.endpoint", merged.inference.embedding.endpoint, true],
      ...(merged.inference.reranker
        ? [["inference.reranker.endpoint", merged.inference.reranker.endpoint, true] as const]
        : []),
    ] as const) {
      try {
        const url = new URL(value);
        if (!["http:", "https:"].includes(url.protocol)) throw new Error();
        if (exactEndpoint && (url.username || url.password || url.hash)) throw new Error();
      } catch {
        throw new Error(
          exactEndpoint
            ? `${name} must be an absolute HTTP(S) URL without userinfo or a fragment.`
            : `${name} must be an HTTP(S) URL.`,
        );
      }
    }
    for (const [name, apiKeyEnv] of [
      ["inference.embedding.api_key_env", merged.inference.embedding.api_key_env],
      ...(merged.inference.reranker
        ? [["inference.reranker.api_key_env", merged.inference.reranker.api_key_env] as const]
        : []),
    ] as const) {
      if (
        apiKeyEnv !== undefined &&
        (process.env[apiKeyEnv] === undefined || process.env[apiKeyEnv] === "")
      ) {
        throw new Error(
          `${name} names environment variable "${apiKeyEnv}", but it is unset or empty.`,
        );
      }
    }
  } else {
    throw new Error(`Invalid inference.mode: ${(merged.inference as { mode?: unknown }).mode}`);
  }

  // HTTP server environment overrides
  if (merged.server) {
    if (allowEnvOverrides) {
      const authEnabledStr = getEnv("SKILLMUX_HTTP_AUTH_ENABLED", "HTTP_AUTH_ENABLED");
      if (authEnabledStr !== undefined) {
        merged.server.auth_enabled = authEnabledStr === "true";
      }
      const authTokenEnv = getEnv("SKILLMUX_HTTP_AUTH_TOKEN_ENV", "HTTP_AUTH_TOKEN_ENV");
      if (authTokenEnv !== undefined) {
        merged.server.auth_token_env = authTokenEnv;
      }
      const allowedOriginsStr = getEnv("SKILLMUX_HTTP_ALLOWED_ORIGINS", "HTTP_ALLOWED_ORIGINS");
      if (allowedOriginsStr !== undefined) {
        merged.server.allowed_origins = allowedOriginsStr.split(",").map((o) => o.trim());
      }
      const hostname = getEnv("SKILLMUX_HTTP_HOSTNAME", "HTTP_HOSTNAME");
      if (hostname !== undefined) {
        merged.server.hostname = hostname;
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
    }

    if (merged.server.rate_limit && merged.server.rate_limit.enabled && merged.server.rate_limit.requests_per_minute === undefined) {
      merged.server.rate_limit.requests_per_minute = 60;
    }
  }

  return configSchema.parse(merged) as Config;
}
