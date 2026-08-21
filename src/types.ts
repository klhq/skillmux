export interface RecallConfig {
  k_lexical: number;
  k_vector: number;
  k_rerank?: number;
}

export interface OutputConfig {
  top_k: number;
  max_top_k: number;
}

export interface Thresholds {
  /** @deprecated Use output.top_k instead */
  candidate_limit?: number;
  match_score?: number;
  match_margin?: number;
  candidate_floor?: number;
}

export type ONNXDevice =
  | "cpu"
  | "auto"
  | "gpu"
  | "wasm"
  | "webgpu"
  | "cuda"
  | "dml"
  | "coreml"
  | "webnn"
  | "webnn-npu"
  | "webnn-gpu"
  | "webnn-cpu";

export type ONNXDtype =
  | "q8"
  | "auto"
  | "fp32"
  | "fp16"
  | "int8"
  | "uint8"
  | "q4"
  | "bnb4"
  | "q4f16"
  | "q2"
  | "q2f16"
  | "q1"
  | "q1f16";

export interface ModelConfig {
  model: string;
  device?: ONNXDevice;
  dtype?: ONNXDtype;
}

export interface LocalInferenceConfig {
  mode: "local";
  bundle: string;
  models_dir: string;
  embedding: ModelConfig & { dimension: number };
}

export interface RemoteEmbeddingConfig {
  provider: "openai";
  endpoint: string;
  model: string;
  dimension: number;
  api_key_env?: string;
}

export interface RemoteRerankerConfig {
  adapter: "jina-v1" | "bifrost-v1";
  endpoint: string;
  model: string;
  api_key_env?: string;
}

export interface RemoteInferenceConfig {
  mode: "remote";
  timeout_ms: number;
  embedding: RemoteEmbeddingConfig;
  reranker?: RemoteRerankerConfig;
}

export type InferenceConfig = LocalInferenceConfig | RemoteInferenceConfig;

export interface RateLimitConfig {
  enabled: boolean;
  requests_per_minute: number;
  trust_proxy?: boolean;
}

export interface AdminConfig {
  enabled: boolean;
  token_env: string;
}

export interface ServerConfig {
  auth_enabled: boolean;
  auth_token_env: string;
  allowed_origins: string[];
  hostname?: string;
  rate_limit?: RateLimitConfig;
  admin?: AdminConfig;
}

export interface ConfigPolicy {
  environment_overrides?: boolean;
}

export interface Config {
  config?: ConfigPolicy;
  vault_path: string;
  local_vault_paths: string[];
  state_dir: string;
  recall: RecallConfig;
  output: OutputConfig;
  inference: InferenceConfig;
  server?: ServerConfig;
}

export interface RankedCandidate {
  rank: number;
  skill_id: string;
  description: string;
  score: number | null;
}

export type RetrievalCapability = "exact" | "reranked" | "hybrid" | "lexical";

export type DegradationReason =
  | "embedding_timeout"
  | "embedding_unavailable"
  | "embedding_protocol_error"
  | "reranker_timeout"
  | "reranker_unavailable"
  | "reranker_protocol_error";

export interface ResolveResult {
  retrieval: RetrievalCapability;
  degraded_from?: "reranked" | "hybrid";
  degradation_reason?: DegradationReason;
  candidates: RankedCandidate[];
}

export interface ResolveSkillInput {
  query: string;
  top_k?: number;
  /** Test/ops escape hatch: use lexical retrieval only. Not exposed on the MCP wire. */
  forceLexical?: boolean;
}

export interface FetchSkillInput {
  skill_id: string;
}

export interface FetchSkillResult {
  skill_id: string;
  title: string;
  content_sha256: string;
  body: string;
  files: string[];
}

export interface AuditCandidate {
  skill_id: string;
  score: number | null;
}

export interface AuditRow {
  id: number;
  ts: string;
  query: string;
  retrieval: RetrievalCapability;
  degraded_from?: "reranked" | "hybrid" | null;
  degradation_reason?: DegradationReason | null;
  candidates: AuditCandidate[];
  latency_ms: number;
}

export interface Clients {
  embed(texts: string[]): Promise<Float32Array[]>;
  rerank?: (query: string, docs: { skill_id: string; text: string }[]) => Promise<number[]>;
}
