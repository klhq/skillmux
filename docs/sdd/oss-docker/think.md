# skill-router OSS + Docker — Design Doc

<!-- status: draft 2026-07-15 -->

## Job to Be Done

When an agent developer wants to give their agents skill discovery, they want to
`docker run` a single container that just works out of the box, so they can route
natural-language task descriptions to the right skill without setting up
embedding servers, reranker endpoints, or running calibration manually.

## Current State

skill-router v0.1.0 is a working MCP stdio server on Bun with hybrid recall
(FTS5 + cosine) and cross-encoder reranking. All 11 acceptance criteria are met.
But:

- **No Docker image** — users must install Bun and clone the repo
- **External model dependency** — requires a separately-running Infinity server
  for embeddings (Harrier 0.6B, 3.6 GB) and reranking (bge-reranker-v2-m3, 2.3 GB)
- **stdio-only transport** — can't run as a network service in Docker
- **No OSS packaging** — no CONTRIBUTING.md, no CI for DockerHub, no release workflow

## Proposed Solution

### Architecture: In-Process ONNX Inference

Replace the external HTTP model clients with in-process inference using
[`@huggingface/transformers`](https://huggingface.co/docs/transformers.js) (v4+),
which runs ONNX models via `onnxruntime-node` inside the same Bun process.

```
┌─────────────────────────────────────────────────┐
│  skill-router container                         │
│                                                 │
│  ┌──────────┐   ┌────────────────────────────┐  │
│  │ MCP      │   │ In-process ONNX            │  │
│  │ Server   │──▶│ @huggingface/transformers   │  │
│  │ (stdio + │   │                            │  │
│  │  HTTP)   │   │ embed: BGE-M3 (q8, ~350MB) │  │
│  └──────────┘   │ rerank: bge-reranker-v2-m3 │  │
│       │         │         (q8, ~300MB)        │  │
│       ▼         └────────────────────────────┘  │
│  ┌──────────┐                                   │
│  │ SQLite   │  /vault (ro mount)                │
│  │ FTS5 +   │  /data  (rw state)                │
│  │ vectors  │                                   │
│  └──────────┘                                   │
└─────────────────────────────────────────────────┘
```

Single process. Single container. No Python. No sidecar.

### Model Selection Change

**Harrier 0.6B has no JavaScript/ONNX ecosystem support.** FastEmbed doesn't
list it, Transformers.js has no conversion, and there's no community ONNX
export. We must switch the bundled embedding model.

| Role | Current (external Infinity) | Bundled (in-process ONNX) | Rationale |
|------|---------------------------|--------------------------|-----------|
| Embedding | `microsoft/harrier-oss-v1-0.6b` (1024-dim, 3.6 GB) | `BAAI/bge-m3` quantized INT8 (~350 MB, 1024-dim) | Top MTEB multilingual model with ONNX support; same 1024-dim as Harrier; dense+sparse capable; `@huggingface/transformers` supports it natively |
| Reranker | `BAAI/bge-reranker-v2-m3` (2.3 GB) | `BAAI/bge-reranker-v2-m3` quantized INT8 (~300 MB) | Same model, just quantized; Transformers.js supports cross-encoder `text-classification` pipeline |

**Backwards compatibility**: the `Clients` interface stays identical. The in-process
provider implements `embed()` and `rerank()` with the same signatures as the HTTP
client. External endpoint config still works — users who run their own Infinity/vLLM
can point to it. The in-process provider is used **only when no external URL is
configured**.

### Two Image Variants

```
klhq/skill-router:latest   — full (models baked in, ~1.2 GB)
klhq/skill-router:slim     — no models (~150 MB, lexical-only by default)
```

Same Dockerfile, different build stages. `ARG VARIANT=full` controls the split.

| | `latest` (full) | `slim` |
|---|---|---|
| **Runtime** | Bun | Bun |
| **Embedding** | In-process BGE-M3 q8 | None (lexical-only) |
| **Reranker** | In-process bge-reranker-v2-m3 q8 | None |
| **External endpoints** | Supported (config override) | Supported (opt-in for hybrid) |
| **Image size** | ~1.2 GB | ~150 MB |
| **First resolve latency** | ~2s (model warmup on first call) | ~50ms |
| **Target user** | "It just works" | BYO model endpoints / small vaults |

#### Slim behavior

When `slim` starts with no external endpoint config:
- `resolve_skill` uses **FTS5-only** recall (the existing degraded lane)
- `degraded: true` on every response
- Never returns `outcome: "matched"` (by design — no reranker means no confidence scores)
- Still useful for small vaults where lexical recall is sufficient

When `slim` starts **with** external endpoint config (env vars or config.toml):
- Full hybrid recall, identical to the current behavior
- User brings their own embedding/rerank service

### MCP Transport: Stdio + Streamable HTTP

The server supports **both** transports, selected at startup:

```bash
# stdio (default, current behavior — for local use)
skill-router serve

# HTTP (new — for Docker, remote, multi-client)
skill-router serve --transport http --port 3000
```

| Feature | stdio | Streamable HTTP |
|---------|-------|-----------------|
| Protocol | JSON-RPC over stdin/stdout | JSON-RPC over HTTP POST |
| Use case | Local, IDE, CLI pipes | Docker, remote agents, teams |
| Multi-client | No (1 process per client) | Yes |
| Auth | Implicit (local process) | Out of scope (separate spec) |

Docker defaults to HTTP:

```bash
docker run -d \
  -v ~/.agents/skills:/vault:ro \
  -v skill-router-data:/data \
  -p 3000:3000 \
  klhq/skill-router:latest
```

### Dockerfile Strategy

Multi-stage build:

```dockerfile
# Stage 1: Base — Bun + dependencies + compiled binary
FROM oven/bun:1 AS base
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src/ src/
COPY tsconfig.json ./
RUN bun build --compile src/cli.ts --outfile /app/skill-router

# Stage 2: Models (only for full variant)
FROM base AS models
RUN bun run scripts/download-models.ts

# Stage 3: Slim runtime
FROM gcr.io/distroless/cc-debian12 AS slim
COPY --from=base /app/skill-router /usr/local/bin/skill-router
# onnxruntime native libs needed alongside the binary
COPY --from=base /app/node_modules/onnxruntime-node/bin/ /usr/local/lib/ort/
ENV VAULT_PATH=/vault STATE_DIR=/data PORT=3000
EXPOSE 3000
VOLUME ["/vault", "/data"]
ENTRYPOINT ["skill-router", "serve", "--transport", "http"]

# Stage 4: Full runtime (extends slim + models)
FROM slim AS full
COPY --from=models /app/.models /models
ENV SKILL_ROUTER_MODELS_DIR=/models
```

> **Note**: The `bun build --compile` single-binary avoids needing Bun in the final
> image. The distroless base keeps the attack surface minimal. The ONNX native libs
> (`libonnxruntime.so`) must be copied separately since they're loaded at runtime
> via dlopen, not linked into the compiled binary.
>
> This needs validation — `bun build --compile` with native addons
> (`onnxruntime-node`) may require the full `node_modules` in the final stage
> rather than just the shared library. We'll prototype and adjust.

### Config Strategy for Docker

Hierarchy (highest wins):

1. **Environment variables** — `VAULT_PATH`, `STATE_DIR`, `EMBED_BASE_URL`, `RERANK_BASE_URL`, `SKILL_ROUTER_EMBED_KEY`
2. **Mounted config.toml** — `-v ./config.toml:/etc/skill-router/config.toml:ro`
3. **Built-in defaults** — sensible for Docker (vault at `/vault`, state at `/data`, in-process models)

The Docker-specific defaults differ from the local ones:

| Setting | Local default | Docker default |
|---------|--------------|----------------|
| `vault_path` | `~/.agents/skills` | `/vault` |
| `state_dir` | `~/.local/state/skill-router` | `/data` |
| `embedding.base_url` | `http://127.0.0.1:8080` | `local://` (in-process) |
| `rerank.base_url` | `http://127.0.0.1:7997` | `local://` (in-process) |

The `local://` sentinel URL tells the router to use in-process ONNX inference
instead of HTTP calls. This is set automatically in the full image and can be
used in local installs that have the models downloaded.

### CI/CD: GitHub Actions → DockerHub

```yaml
# .github/workflows/docker.yml
on:
  push:
    tags: ['v*']
  workflow_dispatch:

jobs:
  build-push:
    runs-on: ubuntu-latest
    steps:
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          username: ${{ secrets.DOCKERHUB_USERNAME }}
          password: ${{ secrets.DOCKERHUB_TOKEN }}
      - uses: docker/build-push-action@v6
        with:
          push: true
          target: full
          tags: klhq/skill-router:latest,klhq/skill-router:${{ github.ref_name }}
      - uses: docker/build-push-action@v6
        with:
          push: true
          target: slim
          tags: klhq/skill-router:slim
```

### OSS Readiness Checklist

| Item | Status | Action |
|------|--------|--------|
| LICENSE | ✅ MIT exists | Done |
| README.md | ⚠️ Needs Docker section | Add Docker quick-start, badge, image links |
| CONTRIBUTING.md | ❌ Missing | Create: dev setup, test conventions, PR process |
| `.github/workflows/docker.yml` | ❌ Missing | Create: build + push on tag |
| `.github/workflows/test.yml` | ✅ Exists | Add: Docker build smoke test |
| `config.example.toml` | ⚠️ Needs Docker section | Add Docker-specific config examples |
| Versioning | ⚠️ 0.1.0, no release process | Add: tag-based releases, CHANGELOG.md |
| `package.json` publishability | ⚠️ No bin/exports | Add: `bin`, `files`, `exports` |

## Scope

**In:**
- In-process ONNX inference via `@huggingface/transformers` (embed + rerank)
- `Clients` interface: new `LocalOnnxClients` alongside existing `HttpClients`
- Streamable HTTP transport for MCP server
- Multi-stage Dockerfile (full + slim variants)
- Model download script (`scripts/download-models.ts`)
- GitHub Actions workflow for DockerHub publish
- Docker-specific config defaults + env var overrides
- README Docker section, CONTRIBUTING.md
- Platform: linux/amd64 only

**Out of scope:**
- Authentication on HTTP transport (separate spec)
- Multi-arch images (arm64 — revisit if requested)
- Kubernetes manifests / Helm chart
- Docker Compose (single container, no sidecar)
- Changing the MCP tool contract (schema.json unchanged)
- Starter vault / example skills in the image
- Model fine-tuning or custom model support
- `bun build --compile` for the full variant if native addon issues arise (fallback: ship with Bun runtime in the image)

## Alternatives Considered

| Approach | Effort | Risk | Upside |
|----------|--------|------|--------|
| **A: In-process ONNX (chosen)** | Medium (new inference code + Docker) | ONNX/Bun compat issues; `bun build --compile` may not work with native addons | Single container, single process, simplest for users, smallest image |
| **B: Infinity sidecar (docker-compose)** | Low (just write Dockerfile + compose) | Users must understand multi-container setup; Infinity is 2+ GB Python image | No new inference code; uses proven Infinity server |
| **C: Runtime model download** | Low-medium | First-run latency (download 650 MB); needs internet; cache invalidation | Smallest image; always latest models |

**Why A wins**: The whole pitch of "battery-included" is `docker run` and it
works. A sidecar adds cognitive overhead. Runtime download adds first-run latency
and internet dependency. In-process ONNX is more code but the best user experience.

## Open Questions

1. **`bun build --compile` + `onnxruntime-node`**: The compiled binary loads
   `libonnxruntime.so` via dlopen. Does this work from distroless, or do we need
   the full Bun runtime in the image? → **Prototype in Task 1.**

2. **BGE-M3 quality vs Harrier**: Is the embedding quality regression acceptable
   for the bundled version? Users with access to Harrier on a remote host can
   still point to it. → **Run eval with BGE-M3 after Task 1.**

3. **Model cache warming**: Should the container warm up models at startup
   (blocking until ready) or lazily on first request? Startup warmup adds ~2s
   but guarantees the first resolve is fast. → **Decision during Task 2.**

4. **Quantization level**: INT8 is the safe default. INT4 halves size again but
   may degrade quality on short skill descriptions. → **Eval both after Task 1.**

## Tasks

### Task 1: In-Process ONNX Inference Provider
- Add `@huggingface/transformers` dependency
- Implement `LocalOnnxClients` matching the `Clients` interface
- Write `scripts/download-models.ts` (downloads + quantizes to local dir)
- Add `local://` sentinel URL detection in config
- Tests: mock-free inference tests with small test models
- **Validate**: `bun build --compile` with ONNX native addons
- **Validate**: run `skill-router eval` with BGE-M3 vs Harrier

### Task 2: Streamable HTTP Transport
- Add `--transport http --port N` CLI flag
- Implement MCP Streamable HTTP transport using `@modelcontextprotocol/sdk`
- Docker-specific config defaults (vault at `/vault`, state at `/data`)
- Environment variable overrides (`VAULT_PATH`, `STATE_DIR`, etc.)
- Tests: HTTP transport e2e (resolve + fetch over HTTP)

### Task 3: Docker + CI/CD + OSS Packaging
- Multi-stage Dockerfile (base → models → slim → full)
- `.github/workflows/docker.yml` (build + push on tag)
- Docker build smoke test in existing CI
- README.md Docker section + badges
- CONTRIBUTING.md
- `package.json` publishability fields (`bin`, `files`, `exports`)
- CHANGELOG.md stub

**Dependency**: Task 1 → Task 3 (Dockerfile needs the inference provider).
Task 2 is independent of Task 1 but blocks Task 3 (Docker needs HTTP transport).

## Next Step

Run `/spec` to turn this into acceptance criteria + testable tasks.
