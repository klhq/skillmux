# Deployment

Choose a deployment from the client count and inference source:

| Use case | Recommended package | Transport | Inference |
| --- | --- | --- | --- |
| Native skill management | Skillmux CLI | Filesystem | None required |
| Local MCP retrieval | Skillmux CLI | stdio | Downloaded GTE-small |
| Shared MCP with local inference | Skillmux server (full image) | Streamable HTTP | Bundled GTE-small |
| Shared MCP with remote or lexical retrieval | Skillmux server (slim image, advanced) | Streamable HTTP | Remote endpoint or lexical fallback |

Install the CLI with npm, bun, or a direct executable download; every path
delivers the same commands and can also serve HTTP. The direct download has a
[pinned, checksum-verified procedure](getting-started.md#standalone-executable)
that defaults to `~/.local/bin`, plus an
[attested GitHub CLI path](getting-started.md#install-with-github-cli-attestation).
Deploy the full image
for a shared Skillmux server by default. Docker can serve stdio when a client
requires a container command; use slim only for remote or lexical retrieval.

“Local inference” means the model runs in the Skillmux process. It does not
mean that the MCP client must run on the same machine.

## Skillmux CLI

Run stdio MCP beside one client:

```sh
skillmux models download
skillmux index
skillmux serve
```

Run an HTTP service without Docker:

```sh
skillmux serve --transport http --port 3000
```

The native HTTP server binds `127.0.0.1` by default. Configure authentication
and a reachable hostname before serving other machines.

Neither native command needs a config file or an existing `~/.config/skillmux`
directory. They use safe defaults until you add a config for a vault checkout,
remote inference, or server policy.

## Skillmux server images

Skillmux publishes Linux AMD64 and ARM64 images to GHCR and Docker Hub:

| Variant | GHCR tag | Contents |
| --- | --- | --- |
| Full | `ghcr.io/klhq/skillmux:latest` | Runtime plus bundled GTE-small |
| Slim | `ghcr.io/klhq/skillmux:latest-slim` | Runtime without model files; remote or lexical retrieval |

Docker Hub mirrors the same tags under `docker.io/klhq/skillmux`.

Neither image bundles a local reranker. Configure a remote reranker when your
retrieval policy needs one.

Use the full image when the service should run embeddings itself:

```sh
docker run -d \
  --name skillmux \
  -v ~/skills:/vault:ro \
  -v skillmux-data:/data \
  -p 3000:3000 \
  ghcr.io/klhq/skillmux:latest
```

The container sets:

- `VAULT_PATH=/vault`;
- `STATE_DIR=/data`;
- `PORT=3000`;
- `RUNNING_IN_DOCKER=true`.

Mount the vault read-only for a retrieval-only service. Run `install`, `init`,
`sync`, and other filesystem management commands on the host. Containerized
native management is intentionally rejected: agent directories belong to the
host CLI, where their symlinks resolve correctly.

## Container command contract

The image separates its executable from its default command. Running an image
without arguments starts Streamable HTTP MCP on port 3000:

```sh
docker run ghcr.io/klhq/skillmux:latest
```

This default works without mounting or creating a config path. The image uses
`/vault` and `/data`; mount them when you need a persistent vault checkout or
index state.

Arguments after the image replace that default, so one-shot maintenance and
stdio use the same image:

```sh
docker run --rm -v ~/skills:/vault:ro -v skillmux-data:/data \
  ghcr.io/klhq/skillmux:latest doctor
docker run --rm -v ~/skills:/vault:ro -v skillmux-data:/data \
  ghcr.io/klhq/skillmux:latest index
```

Docker Compose `command:` and Kubernetes `args:` likewise replace only the
default command, not the executable.

The supported container commands are `serve`, `index`, `doctor`, `report`,
`scan`, `skill list`, `skill which`, and read-only `config show`, `config get`,
`config validate`, `config diff`, and `config status`.

The image rejects host-management commands, including `init`, `sync`,
`install`, `project`, `agent`, `core`, `local-vault`, `models download`,
context management, evaluation, and configuration initialization
or mutation. Install the Skillmux CLI on the host when a command needs to
manage a local vault or agent directory.

A rejected command exits with code 2 and tells you the exact host command to
run. In `--json` mode, the error code is
`CONTAINER_COMMAND_UNSUPPORTED`; `error.details.rejected_command`,
`recommended_host_command`, and `documentation` are stable automation fields.
For example, `docker run --rm ghcr.io/klhq/skillmux:latest models download
--json` recommends `skillmux models download` on the host.

## Slim image

The slim image stays ready in lexical mode without an inference endpoint.
Configure remote embeddings to enable hybrid retrieval:

```sh
docker run -d \
  --name skillmux-slim \
  -v ~/skills:/vault:ro \
  -v skillmux-data:/data \
  -p 3000:3000 \
  -e EMBED_ENDPOINT="https://embedding.example.com/v1/embeddings" \
  -e EMBED_MODEL="your-embedding-model" \
  -e EMBED_DIMENSION="1024" \
  ghcr.io/klhq/skillmux:latest-slim
```

Set `SKILLMUX_CONFIG` and mount a TOML file when you need reranking, custom
recall/output settings, server policy, or API-key environment names:

```sh
docker run -d \
  --name skillmux-slim \
  -v ~/skills:/vault:ro \
  -v skillmux-data:/data \
  -v "$PWD/config.toml:/etc/skillmux/config.toml:ro" \
  -e SKILLMUX_CONFIG=/etc/skillmux/config.toml \
  -e EMBEDDING_API_KEY \
  -e RERANKER_API_KEY \
  -p 3000:3000 \
  ghcr.io/klhq/skillmux:latest-slim
```

Start from [config.remote.example.toml](../config.remote.example.toml).

## Docker over stdio

Some local clients can launch a container as their stdio MCP command:

```sh
docker run --no-healthcheck -i --rm \
  -v ~/skills:/vault:ro \
  -v skillmux-data:/data \
  ghcr.io/klhq/skillmux:latest serve --transport stdio
```

The container must keep standard input open, so use `-i`. Disable the baked
HTTP health check for stdio because no HTTP listener is started.

## HTTP surfaces

The shared server exposes two distinct HTTP surfaces:

| Surface | User | Purpose | CLI required |
| --- | --- | --- | --- |
| `/mcp` | AI clients | Resolve and fetch skills | No |
| `/admin/v1/*` (and `GET /stats`) | Operators | Inspect/update config, stats, audit prune, evaluation, and remote diagnostics | Yes, when using named CLI contexts |

Configure and distribute separate bearer tokens. An MCP token authenticates an
AI client to `/mcp` only; an administrative token authenticates an operator to
`/admin/v1/*` only. Neither token grants access to the other surface.

### Stateless MCP over HTTP

`/mcp` holds no sessions. Every POST is served on its own, so one server
process serves any number of AI clients at once, in either
[protocol era](mcp-routing.md#protocol-versions):

- `2026-07-28` clients send each request with the `_meta` envelope and the
  `MCP-Protocol-Version`, `Mcp-Method` and `Mcp-Name` headers. That protocol
  has no sessions.
- 2025-era clients still send `initialize` first, and it succeeds, but the
  server issues no `Mcp-Session-Id`. Later requests work with or without one.
- `GET /mcp` (the 2025-era server-to-client stream) and `DELETE /mcp` (session
  termination) return `405 Method Not Allowed`. Skillmux sends no
  server-to-client requests or notifications, so clients lose nothing.

## Expose HTTP safely

The Skillmux CLI binds `127.0.0.1`. Docker binds `0.0.0.0` so
port mapping works. Before exposing the port beyond a trusted host:

```toml
[server]
hostname = "0.0.0.0"
auth_enabled = true
auth_token_env = "SKILLMUX_AUTH_TOKEN"
allowed_origins = []

[server.rate_limit]
enabled = true
requests_per_minute = 60
trust_proxy = false

[server.admin]
enabled = true
token_env = "SKILLMUX_ADMIN_TOKEN"
```

Set the token in the process environment:

```sh
export SKILLMUX_AUTH_TOKEN="replace-with-an-mcp-token"
export SKILLMUX_ADMIN_TOKEN="replace-with-a-separate-admin-token"
skillmux serve --transport http
```

Clients send:

```text
Authorization: Bearer replace-with-an-mcp-token
```

`allowed_origins` controls browser CORS requests. Requests without an `Origin`
header, including MCP clients and curl, do not need a CORS entry.

The `Authorization` example above is for an MCP client calling `/mcp`.
Administrative requests instead use the token named by `server.admin.token_env`.

Keep `trust_proxy = false` unless a trusted reverse proxy overwrites
`X-Forwarded-For`. A client can spoof that header when it reaches Skillmux
directly.

`skillmux serve --transport http` enforces this itself: it refuses to bind a
non-loopback hostname (including Docker's default `0.0.0.0`) while
`auth_enabled` is `false`, since that combination leaves `/mcp` and `/stats`
open to anyone who can reach the port. `skillmux doctor` flags the same
combination as `server_bind_posture`. If you're relying on network-level
isolation instead of application auth — e.g. a container with no published
port, reachable only inside a private Docker network — set
`SKILLMUX_ALLOW_INSECURE_BIND=true` to start anyway; the server logs a loud
warning each time it does.

## Health and metrics

The HTTP server provides:

| Endpoint | Purpose |
| --- | --- |
| `GET /health/live` | Process liveness |
| `GET /health/ready` | Vault, index, inference, active capability, version, runtime, and image variant |
| `GET /health` | Compatibility alias for liveness |
| `GET /metrics` | Prometheus text exposition |
| `GET /stats` | Aggregated routing statistics for `skillmux report` |
| `POST /mcp` | Streamable HTTP MCP transport, stateless (`GET` and `DELETE` return 405) |
| `/admin/v1/*` | Administrative configuration API (when enabled) |

The Docker health check calls `/health/ready`.

`GET /stats` returns JSON aggregated from audit rows over a query window (using `?since=`, defaulting to 24 hours). The response contains `since`, `until`, `total_requests`, `empty_shortlist_count`, `empty_shortlist_rate`, `retrieval_totals` (counts for `exact`, `reranked`, `hybrid`, and `lexical`), `degraded_count`, `average_latency_ms`, per-skill candidate counts in `skills` (`skill_id`, `candidate_count`), `top_empty_shortlist_queries` (`query`, `count`), an `acceptance` signal derived from fetches correlated to their resolve (`acceptance_rate`, `observed_mrr`, `top1_acceptance_rate`, `accepted_count`, `resolves_with_candidates`, and `uncorrelated_fetch_count`, or `available: false` with just the uncorrelated count when a window has no correlated fetches), and `top_unused_shortlist_queries` (`query`, `count`) for queries that returned candidates but received no correlated fetch, plus a `context_savings` block of estimated token counts (see [the report docs](cli.md#observability-and-evaluation-skillmux-report-audit-eval)). See [Managing skills](skill-management.md#use-routing-data-to-tune-tiers) for using these statistics to tune delivery tiers.

Prometheus metrics cover request totals, resolve latency histograms, errors,
rate-limit rejections, degraded retrieval totals by stage and reason, readiness
and active retrieval capability gauges, a `skill_router_native_baseline_tokens`
gauge (the estimated tokens a native-only client spends each session listing the
unpinned skills, cached for a minute), and a `skill_router_deployment_info` gauge
labelled with `version`, `runtime`, and `image_variant`. Three routing-quality
counters show whether routing works, not only whether the server is up:
`skill_router_resolve_results_total{result="candidates|empty"}`,
`skill_router_fetch_ranked_total{rank}` for `fetch_skill` calls linked to a
`resolve_skill` call (ranks `1` to `10`, `11+`, and `none` when the fetched
skill was not in the shortlist), and `skill_router_fetch_uncorrelated_total`.
When `vault_pull_interval` is set, `skill_router_vault_pull_total{result}` and
`skill_router_vault_last_pull_success_timestamp_seconds` report the vault pulls.
Top-1 acceptance is `rank="1"` over the sum of the ranked buckets. They carry no
query text or skill IDs as labels, and they count only `SKILL.md` fetches, not
supporting files. The values match `skillmux doctor`,
`skillmux config status`, and `/health/ready`; use `image_variant="none"` for
a host runtime. These operational outputs never include credentials, API keys,
or token values.

Read the routing counters as a trend, not as ground truth. Linking a fetch to
its resolve needs the client to pass `request_id` to `fetch_skill`, so ranked
counts are a lower bound and the uncorrelated counter shows how much is
missing. A fetch also does not prove the choice was right, and models tend to
pick the first candidate, so acceptance overstates quality. Counters reset when
the server restarts. `/metrics` exists only on the HTTP transport; stdio users
get the same numbers from `skillmux report`.

Health and metrics do not require bearer authentication, but
`/stats` does when server authentication is enabled. CORS still applies to
browser requests.

## Remote administration

Name a deployed server without storing its **administrative** token:

```sh
skillmux context add prod \
  --server https://skillmux.example.com \
  --token-env SKILLMUX_PROD_ADMIN_TOKEN
skillmux context use prod
skillmux config status
skillmux --context prod report --since 7d
skillmux --context prod audit prune --dry-run
skillmux --context prod doctor
```

The context stores the token environment variable name. Export its value in
the shell before running admin commands. This token is separate from the MCP
token configured with `server.auth_token_env`; it does not authenticate MCP
clients.

Enable the admin API and use a separate admin token in server configuration.
Read [CLI reference](cli.md#administrative-http-api-adminv1) for routes and
[Configuration](configuration.md#http-server) for reload behavior.

Named contexts administer the deployed server only — configuration, stats,
audit prune, evaluation, and remote diagnostics. They do not install, pin,
synchronize, or otherwise manage skill directories on remote agent machines.
Run those filesystem-management commands through Skillmux CLI on the machine
that owns the directories. The full and slim server images read their mounted
vault checkout and do not manage host agent directories.

## Persistent data and backups

Persist `state_dir` to retain both state files it holds: `index.sqlite3`
(retrieval index and vector matrix) and `audit.sqlite3` (resolve and fetch
audit rows). Skill content remains in the server's vault checkout and should
use its own backup or Git workflow.

The two files are independent and can be backed up on different schedules.
Copying or backing up `index.sqlite3` alone never carries raw user queries;
only `audit.sqlite3` does. `audit.sqlite3` is created with WAL journaling and
incremental auto-vacuum, so `skillmux audit prune` reclaims space without
taking a lock on `index.sqlite3`. On first startup after an upgrade from a
version that kept audit rows inside `index.sqlite3`, Skillmux migrates them
into `audit.sqlite3` once, transactionally; the migration is idempotent, so
it is safe to leave running unattended.

Treat `audit.sqlite3` as sensitive because its rows can contain raw user
queries. Stop the process or use SQLite-safe backup tooling before copying a
live database. `audit.retention_days` (default 90; `0` disables pruning) ages
out old rows automatically at startup and at most once per 24 hours while the
server runs; see [CLI reference](cli.md#observability-and-evaluation-skillmux-report-audit-eval)
for the on-demand `skillmux audit prune` command.

## Let the server pull its vault

By default the server image reads a checkout that something else keeps current,
which is why the examples above mount the vault with `:ro`. If you have no
orchestrator or cron job to do that, set `vault_url` and `vault_pull_interval`
and let the server own the checkout. The vault mount must then be writable:

```toml
# /etc/skillmux/config.toml
vault_path = "/vault"
vault_url = "https://github.com/you/skills.git"
vault_pull_interval = "10m"
```

```sh
docker run -d \
  --name skillmux \
  -v skillmux-vault:/vault \
  -v skillmux-data:/data \
  -v "$PWD/config.toml:/etc/skillmux/config.toml:ro" \
  -e SKILLMUX_CONFIG=/etc/skillmux/config.toml \
  -p 3000:3000 \
  ghcr.io/klhq/skillmux:latest-slim
```

The first start clones the vault into the empty volume and indexes it, and
later pulls pick up whatever you push within one interval. For a private
repository, mount a read-only deploy key and set `GIT_SSH_COMMAND` to use it, or
put a read-only token in the URL through your secret mechanism. A public
repository needs no credentials. The image includes `git` for this.

Watch `skill_router_vault_last_pull_success_timestamp_seconds` on `/metrics`. If
it stops advancing, the server is serving older content than the remote has. See
[Server pulls](configuration.md#server-pulls) for the exact behavior when a pull
fails.

## Push a local vault to the server

When the vault is a plain directory with no git remote, `skillmux vault push`
uploads it over the administrative API:

```toml
# server config.toml
vault_path = "/vault"

[server.admin]
enabled = true
token_env = "SKILLMUX_ADMIN_TOKEN"

[server.admin.vault_push]
enabled = true
```

Mount the vault writable, because the server swaps skill directories inside it:

```sh
docker run -d \
  --name skillmux \
  -v skillmux-vault:/vault \
  -v skillmux-data:/data \
  -v "$PWD/config.toml:/etc/skillmux/config.toml:ro" \
  -e SKILLMUX_CONFIG=/etc/skillmux/config.toml \
  -e SKILLMUX_ADMIN_TOKEN="replace-with-a-separate-admin-token" \
  -p 3000:3000 \
  ghcr.io/klhq/skillmux:latest-slim
```

Then, from the machine that has the vault:

```sh
skillmux context add prod --server https://skillmux.example.com --token-env SKILLMUX_ADMIN_TOKEN
skillmux vault push --context prod --dry-run
skillmux vault push --context prod --yes
```

The server scans the upload, replaces its vault in one step, and reindexes
before it answers the next query. Use HTTPS for any server that is not on
loopback, because the admin token travels with every push. A server uses one
source of truth: it refuses a push when it also sets `vault_url`. See
[Vault push](configuration.md#vault-push) for the limits, the checks and the
audit trail, and read its security notes before you enable it.

## Native pins with shared retrieval

For the combined topology, use one Git-backed vault source of truth. A vault
checkout is a physical copy: each machine that manages native skills keeps its
own checkout and runs the Skillmux CLI; the shared service mounts its own
checkout for retrieval. On one machine, `~/skills` can be both the source of
truth and its checkout. Skillmux never pushes or replicates a checkout. By
default it also does not pull one, and Git and your deployment process own
freshness. A server can opt in to pulling its own checkout with
[`vault_pull_interval`](#let-the-server-pull-its-vault), or to receiving one
from `skillmux vault push` when the vault has no git remote. The server image
does not manage host agent directories.
