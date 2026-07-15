export interface RecallConfig {
  k_lexical: number;
  k_vector: number;
}

export interface Thresholds {
  match_score: number;
  match_margin: number;
  candidate_floor: number;
  candidate_limit: number;
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

export interface EmbeddingConfig {
  base_url: string;
  api_key_env: string;
  model: string;
  dimension: number;
  device?: ONNXDevice;
  dtype?: ONNXDtype;
}

export interface RerankConfig {
  base_url: string;
  model: string;
  device?: ONNXDevice;
  dtype?: ONNXDtype;
}

export interface RateLimitConfig {
  enabled: boolean;
  requests_per_minute: number;
}

export interface ServerConfig {
  auth_enabled: boolean;
  auth_token_env: string;
  allowed_origins: string[];
  rate_limit?: RateLimitConfig;
}

export interface Config {
  vault_path: string;
  state_dir: string;
  recall: RecallConfig;
  thresholds: Thresholds;
  embedding: EmbeddingConfig;
  rerank: RerankConfig;
  remote_timeout_ms: number;
  server?: ServerConfig;
}

export interface Candidate {
  skill_id: string;
  title: string;
  description: string;
  rerank_score: number | null;
}

export interface MatchedResult {
  outcome: "matched";
  degraded: false;
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
  degraded: boolean;
  candidates: Candidate[];
}

export interface NoMatchResult {
  outcome: "no_match";
  degraded: boolean;
  message: string;
}

export type ResolveResult = MatchedResult | AmbiguousResult | NoMatchResult;

export interface ResolveSkillInput {
  query: string;
  /** Test/ops escape hatch: skip remote lanes. Not exposed on the MCP wire (schema allows only `query`). */
  forceDegraded?: boolean;
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
  degraded: boolean;
  candidates: AuditCandidate[];
  selected_skill_id: string | null;
  latency_ms: number;
}

export interface Clients {
  embed(texts: string[]): Promise<Float32Array[]>;
  rerank(query: string, docs: { skill_id: string; text: string }[]): Promise<number[]>;
}
