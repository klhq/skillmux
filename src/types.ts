export interface RecallConfig {
  k_lexical: number;
  k_vector: number;
}

export interface Thresholds {
  candidate_limit: number;
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
  base_url: string;
  model: string;
  dimension: number;
  api_key_env?: string;
}

export interface RemoteRerankerConfig {
  provider: "infinity";
  base_url: string;
  model: string;
  api_key_env?: string;
}

export interface RemoteInferenceConfig {
  mode: "remote";
  timeout_ms: number;
  embedding: RemoteEmbeddingConfig;
  reranker?: RemoteRerankerConfig;
  thresholds?: Required<Omit<Thresholds, "candidate_limit">>;
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

export interface Config {
  vault_path: string;
  local_vault_paths: string[];
  state_dir: string;
  recall: RecallConfig;
  thresholds: Thresholds;
  inference: InferenceConfig;
  server?: ServerConfig;
}

export interface Candidate {
  skill_id: string;
  title: string;
  description: string;
}

export interface RankedCandidate extends Candidate {
  score: number | null;
}

export type RetrievalCapability = "exact" | "reranked" | "hybrid" | "lexical";

export interface MatchedResult {
  outcome: "matched";
  retrieval: "exact" | "reranked";
  skill_id: string;
  title: string;
  content_sha256: string;
  score: number;
  margin: number;
  body: string;
  files: string[];
}

export interface AmbiguousResult {
  outcome: "ambiguous";
  retrieval: RetrievalCapability;
  candidates: Candidate[];
}

export interface NoMatchResult {
  outcome: "no_match";
  retrieval: RetrievalCapability;
  message: string;
}

export type ResolveResult = MatchedResult | AmbiguousResult | NoMatchResult;

export interface ResolveSkillInput {
  query: string;
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
  outcome: "matched" | "ambiguous" | "no_match";
  retrieval: RetrievalCapability;
  candidates: AuditCandidate[];
  selected_skill_id: string | null;
  latency_ms: number;
}

export interface Clients {
  embed(texts: string[]): Promise<Float32Array[]>;
  rerank?: (query: string, docs: { skill_id: string; text: string }[]) => Promise<number[]>;
}
