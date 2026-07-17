# skill-router

A local, read-only [MCP](https://modelcontextprotocol.io) stdio server that gives agents **on-demand skill discovery**: route a natural-language task description to the right skill in your vault and deliver its `SKILL.md` byte-for-byte, verified by SHA-256.

Built for agents that lack native skill triggering (Goose recipe workers, opencode, and friends). Agents that already trigger skills natively (e.g. Claude Code) don't need it.

## How it works

```
resolve_skill("convert this spreadsheet to markdown")
        │
        ▼
  hybrid recall: SQLite FTS5 (BM25)  ∪  embedding cosine (brute-force)
        │
        ▼
  cross-encoder rerank  →  matched | ambiguous | no_match
```

- **matched** — one skill clearly wins: full `SKILL.md` delivered inline, `sha256(body) == content_sha256 ==` hash of the file on disk at delivery time. Stale index? It re-indexes and delivers fresh bytes — never stale ones.
- **ambiguous** — up to 5 candidates (id, title, description, score). The calling LLM picks and calls `fetch_skill`. The router advises; it never decides for you.
- **no_match** — proceed under your normal workflow; don't load an unrelated skill.

If the embedding or rerank endpoint is down or slow, the router **degrades instead of failing**: FTS5-only recall, never `matched`, `degraded: true`. Startup and resolution work with the model host fully offline.

### Tools

| Tool | Input | Returns |
|------|-------|---------|
| `resolve_skill` | `query` | outcome + metadata in `structuredContent`; on match the verbatim body as text content (exactly once on the wire) |
| `fetch_skill` | `skill_id` | verbatim body, `content_sha256`, supporting-file paths |

The full contract lives in [`docs/sdd/router-core/schema.json`](docs/sdd/router-core/schema.json) (JSON Schema 2020-12, language-neutral).

## Requirements

- [Bun](https://bun.sh) ≥ 1.3
- A skill vault: one directory per skill with a `SKILL.md` in [agentskills.io](https://agentskills.io) format (`name`, `description`, optional `aliases` frontmatter). Default location `~/.agents/skills`.
- Optional (for the hybrid lane): an OpenAI-compatible embeddings endpoint and an [Infinity](https://github.com/michaelfeil/infinity)-native `/rerank` endpoint. Without them the router still works, lexical-only.

## Quick start

```sh
bun install
cp config.example.toml ~/.config/skill-router/config.toml   # then edit
bun run src/cli.ts index    # build the index (< 5 s for ~100 skills)
bun run src/cli.ts serve    # stdio MCP server
```

Register with your MCP client directly, e.g.:

```json
{
  "mcpServers": {
    "skill-router": {
      "command": "bun",
      "args": ["run", "/path/to/skill-router/src/cli.ts", "serve"]
    }
  }
}
```

Or compile a single-file binary:

```sh
bun run build              # → dist/skill-router
dist/skill-router serve
```

## Docker Usage

The `skill-router` is packaged and distributed as a Docker image in two variants:

1. **`klhq/skill-router:latest` (Battery-Included, ~1.2GB)**: Bundles quantized `BAAI/bge-m3` and `BAAI/bge-reranker-v2-m3` ONNX models for in-process local inference out of the box. No external model servers required.
2. **`klhq/skill-router:slim` (Model-free, ~150MB)**: Excludes weights. Runs in FTS5 lexical-only mode by default, or integrates with your custom remote API endpoints.

### Running HTTP Server (Docker Default)

To run as an HTTP MCP service (default in Docker):

```sh
# Battery-included (runs local in-process ONNX models)
docker run -d \
  -name skill-router \
  -v ~/.agents/skills:/vault:ro \
  -v skill-router-data:/data \
  -p 3000:3000 \
  klhq/skill-router:latest

# Slim (requires external model endpoints, or runs lexical-only degraded)
docker run -d \
  -name skill-router-slim \
  -v ~/.agents/skills:/vault:ro \
  -v skill-router-data:/data \
  -p 3000:3000 \
  -e EMBED_BASE_URL="http://embeddings-host:8080" \
  -e RERANK_BASE_URL="http://reranker-host:7997" \
  klhq/skill-router:slim
```

Connect your MCP client to the HTTP endpoint (e.g. standard Streamable HTTP transport):
- POST messages to `http://localhost:3000`

#### HTTP server: auth, CORS, rate limiting

All of the below is `[server]` config in `config.toml`, overridable by environment variable — see [Environment Variable Overrides](#environment-variable-overrides).

- **Bearer token auth** (off by default) — set `auth_enabled = true` and the token via the env var named by `auth_token_env` (default `SKILL_ROUTER_AUTH_TOKEN`). Requests need `Authorization: Bearer <token>`; missing/mismatched tokens get `401`, and a configured-but-empty token env var gets `500`.
- **CORS** — `allowed_origins` (default `["*"]`) is checked against the request's `Origin` header; disallowed origins get `403`. `/health` and `/metrics` are excluded from auth but still CORS-checked.
- **Rate limiting** (off by default) — per-token (when auth is enabled) or per-IP (`server.requestIP`, falling back to `X-Forwarded-For`) token-bucket limiting. Enable with `rate_limit.enabled = true` and set `rate_limit.requests_per_minute` (default `60`). Every response carries `X-RateLimit-Limit`/`X-RateLimit-Remaining`/`X-RateLimit-Reset`; over-limit requests get `429` plus `Retry-After`.
- **`GET /health`** — liveness check, `{"status": "ok"}`.
- **`GET /metrics`** — Prometheus text exposition: `skill_router_requests_total`, `skill_router_resolve_outcomes_total`, `skill_router_resolve_latency_seconds` (histogram), `skill_router_errors_total`, `skill_router_rate_limits_exceeded_total`.

### Running Stdio Server in Docker

If your agent runs locally and expects a piped stdio process:

```sh
docker run -i --rm \
  -v ~/.agents/skills:/vault:ro \
  klhq/skill-router:latest serve --transport stdio
```

## Configuration

No config is required for the battery-included local ONNX mode. See [`config.example.toml`](config.example.toml) for the minimal local setup, [`config.remote.example.toml`](config.remote.example.toml) for bring-your-own endpoints, and [`docs/configuration.md`](docs/configuration.md) for advanced settings.

### Inference Modes

- `inference.mode = "local"` is the default and runs the versioned BGE-M3 ONNX bundle in process. Models download on first use or via `skill-router models download`.
- `inference.mode = "remote"` uses an OpenAI-compatible embeddings endpoint and an Infinity-compatible reranker endpoint.

Run `skill-router doctor` to verify full hybrid routing. Run `skill-router config show` to inspect the effective configuration; it prints credential variable names, never credential values.

### Environment Variable Overrides
All core settings can be overridden via environment variables (handy for Docker):
- `VAULT_PATH` / `SKILL_ROUTER_VAULT_PATH` — overrides `vault_path` (defaults to `/vault` inside Docker)
- `STATE_DIR` / `SKILL_ROUTER_STATE_DIR` — overrides `state_dir` (defaults to `/data` inside Docker)
- `EMBED_BASE_URL` / `SKILL_ROUTER_EMBED_BASE_URL` — overrides remote `inference.embedding.base_url`
- `EMBED_MODEL` / `SKILL_ROUTER_EMBED_MODEL` — overrides `embedding.model`
- `EMBED_DIMENSION` / `SKILL_ROUTER_EMBED_DIMENSION` — overrides `embedding.dimension`
- `EMBED_DEVICE` / `EMBED_DTYPE` — overrides local `inference.embedding.device` / `inference.embedding.dtype`
- `RERANK_BASE_URL` / `SKILL_ROUTER_RERANK_BASE_URL` — overrides remote `inference.reranker.base_url`
- `RERANK_MODEL` / `SKILL_ROUTER_RERANK_MODEL` — overrides `rerank.model`
- `RERANK_DEVICE` / `RERANK_DTYPE` — overrides local `inference.reranker.device` / `inference.reranker.dtype`
- `SKILL_ROUTER_CONFIG` — path to custom `config.toml` (default `~/.config/skill-router/config.toml`)
- `SKILL_ROUTER_MODELS_DIR` — path to directory storing downloaded local models (default `./.models`)
- `PORT` — HTTP listen port (default `3000`, HTTP transport only)
- `HTTP_AUTH_ENABLED` — overrides `server.auth_enabled` (`"true"` to enable)
- `HTTP_AUTH_TOKEN_ENV` — overrides `server.auth_token_env`
- `HTTP_ALLOWED_ORIGINS` — comma-separated list, overrides `server.allowed_origins`
- `HTTP_RATE_LIMIT_ENABLED` / `SKILL_ROUTER_HTTP_RATE_LIMIT_ENABLED` — overrides `server.rate_limit.enabled` (`"true"` to enable)
- `HTTP_RATE_LIMIT_RPM` / `SKILL_ROUTER_HTTP_RATE_LIMIT_RPM` — overrides `server.rate_limit.requests_per_minute`

Remote API keys are read from the environment variables named by `inference.embedding.api_key_env` and `inference.reranker.api_key_env`; no secret ever lives in the config file.

Calibrate thresholds against your own vault:

```sh
bun run src/cli.ts eval
# holdout queries: 212
# recall@5 lexical-only: 0.868
# recall@5 hybrid:       0.943
# suggested config.toml [thresholds]: ...
```

## Guarantees

- **Read-only vault** — no code path writes under the vault; all state is confined to `state_dir`. Covered by tests.
- **Zero-loss delivery** — delivered bytes always hash-match the file on disk at delivery time.
- **Live index** — a running server folds vault changes (create/modify/delete) into the index within seconds; an unparseable write keeps the previous good entry rather than evicting the skill.
- **Audit log** — every `resolve_skill` call is appended to a SQLite table in `state_dir` (timestamp, query, outcome, candidates with scores, latency).

## Development

```sh
bun test        # full suite (contract, hybrid recall, stdio e2e, watcher, eval)
bun run build   # single-file binary via bun build --compile
```

Design docs: [`docs/sdd/router-core/spec.md`](docs/sdd/router-core/spec.md) (approved spec) and [`docs/sdd/router-core/schema.json`](docs/sdd/router-core/schema.json) (typed contract).
