# Configuration

Skillmux manages one configured vault checkout and defaults to FTS5 plus
GTE-small running in the Skillmux process. The vault source of truth is the
logical collection; a vault checkout is its physical copy. Most users need no
config file.

Deployment and inference use separate terms:

- **local deployment**: Skillmux runs beside a client, usually over stdio;
- **shared deployment**: Skillmux serves clients over HTTP;
- **local inference**: the Skillmux process runs the embedding model;
- **remote inference**: Skillmux calls configured inference endpoints.

A shared HTTP deployment can use local inference. A local stdio deployment can
use remote inference.

Published server images set `SKILLMUX_IMAGE_VARIANT=full` or
`SKILLMUX_IMAGE_VARIANT=slim` themselves. It is an operational identity value,
not an inference setting; use `doctor`, `config status`, `/health/ready`, or
the deployment-info metric to inspect it. Do not put credentials or token
values in any of those outputs.

Read [Concepts](concepts.md#vault-source-of-truth-and-checkouts) for vault
terms and the delivery model. For detailed CLI
commands, target resolution, and automation envelopes, see
[CLI reference](cli.md). For Linux CLI installation, see the
[pinned checksum-verified download](getting-started.md#install-the-cli) or the
[attested GitHub CLI path](getting-started.md#install-with-github-cli-attestation).
For ranking evaluation and upgrading from earlier releases, see
[Ranked-shortlist migration](ranked-shortlist-migration.md).

## Machine config bootstrap

Configuration is optional: `skillmux serve` and `skillmux serve --transport
http` start with defaults even when `~/.config/skillmux` does not exist. The
optional config watcher does not create that directory; reload stays inactive
until the server starts with a watchable config parent. Once active, malformed
updates are reported and the last known good configuration remains in use.

Create `~/.config/skillmux/config.toml` from a populated vault:

```sh
skillmux config init --vault ~/skills --yes
```

The command writes:

```toml
vault_path = "/home/you/skills"
```

It validates that the path resolves to a directory with at least one
`SKILL.md`, preserves an existing config byte-for-byte, and leaves
`local_vault_paths` unset. `skillmux init --vault ~/skills --yes` uses the
same bootstrap when the machine config does not exist.

## Local inference

```toml
[inference]
mode = "local"
```

The versioned `gte-small-v1` configuration uses normalized, mean-pooled
`Xenova/gte-small` embeddings with 384 dimensions, quantized to q8 on CPU.
Skillmux CLI installations download the model when inference first
loads it and cache it in `~/.cache/skillmux/models`. The full image
already contains the model.

Skillmux combines FTS5 and cosine result lists with reciprocal-rank fusion.
Skillmux returns the fused candidates as a ranked shortlist.

Advanced local overrides:

```toml
[inference]
mode = "local"
models_dir = "~/.cache/skillmux/models"

[inference.embedding]
model = "Xenova/gte-small"
dimension = 384
device = "cpu"
dtype = "q8"

```

Use `skillmux models download` to prefetch the model and `skillmux doctor` to
verify readiness.

## Remote inference

See [`config.remote.example.toml`](../config.remote.example.toml). Embeddings
must implement the OpenAI-compatible `{ model, input }` contract. Configure the
complete request URL as `inference.embedding.endpoint`; Skillmux does not append
or rewrite its path or query string. Optional
reranking uses a versioned wire-protocol adapter and a complete request URL:

```toml
[inference.reranker]
adapter = "jina-v1"
endpoint = "https://reranker.example.com/v1/rerank"
model = "BAAI/bge-reranker-v2-m3"
```

`jina-v1` sends documents as strings. `bifrost-v1` sends Bifrost document
objects and requires a Bifrost-style provider-prefixed model name. Skillmux
does not append `/rerank`, infer the adapter from the URL, or otherwise rewrite
the endpoint.

For embeddings and rerankers independently, omitting `api_key_env` sends no
`Authorization` header. If `api_key_env` is configured, the named environment
variable must be non-empty when configuration is loaded; Skillmux sends it as
a Bearer token. The variable name may appear in diagnostics, but its value
never does.

Remote embedding `dimension` is required. `endpoint`, `api_key_env`, and the
shared timeout reload live; model, dimension, device, and dtype require a
restart. Changing only endpoint does not invalidate stored vectors.

Reranker configuration pairs an adapter (such as `jina-v1` or `bifrost-v1`) with a
model name and a complete endpoint URL.

## Configuration authority

By default, Skillmux allows namespaced environment variables (`SKILLMUX_*`) to override values from `config.toml`. When deploying in strict environments where the TOML configuration must be authoritative against runtime container environment drift:

```toml
[config]
environment_overrides = false
```

When `config.environment_overrides = false`:
- Behavioral environment overrides (e.g. `SKILLMUX_VAULT_PATH`, `SKILLMUX_RECALL_K_RERANK`, `EMBED_MODEL`) are ignored and logged as masked by TOML policy.
- `SKILLMUX_CONFIG` (config path pointer), CLI flags (`--vault`, `--config`), and named secret variables referenced via `api_key_env` / `token_env` remain fully authoritative.
- Generic un-namespaced variables (`EMBED_*`, `RERANK_*`, `HTTP_*`, `VAULT_PATH`) are deprecated in 1.x and trigger warnings encouraging the preferred `SKILLMUX_*` namespace.

Inspect provenance and active policy with `skillmux config show --sources` or `skillmux doctor`.

## Advanced retrieval

Candidate-generation depth, reranking candidate budgets, and output candidate shortlist size are separate controls:

```toml
[recall]
k_lexical = 20
k_vector = 20
k_rerank = 10

[output]
top_k = 10
max_top_k = 50
```

- `recall.k_lexical` and `recall.k_vector` control initial candidate generation depth.
- `recall.k_rerank` bounds the candidate shortlist sent to the reranker adapter (defaults to `10`, cannot exceed `k_lexical + k_vector`).
- `output.top_k` sets the default maximum number of candidates returned by `resolve_skill` (defaults to `10`).
- `output.max_top_k` sets the upper bound for per-request `top_k` overrides (defaults to `50`).

### Failure visibility and degraded retrieval

When remote embedding or reranking fails or times out, Skillmux gracefully falls back to the strongest surviving retrieval lane (`hybrid` or `lexical`). The response carries structured degradation metadata:

```json
{
  "retrieval": "hybrid",
  "degraded_from": "reranked",
  "degradation_reason": "reranker_timeout",
  "candidates": [...]
}
```

Stable degradation reason codes:
- `embedding_timeout`, `embedding_unavailable`, `embedding_protocol_error`
- `reranker_timeout`, `reranker_unavailable`, `reranker_protocol_error`

These safe reason codes are exposed via MCP and recorded in the audit database without logging credentials or raw upstream response bodies. Degraded retrieval count metrics are tracked under `skill_router_degraded_retrieval_total{stage,reason}`.

## HTTP server

The HTTP server provides separate MCP and administrative surfaces:

| Surface | User | Purpose | CLI required |
| --- | --- | --- | --- |
| `/mcp` | AI clients | Resolve and fetch skills | No |
| `/admin/v1/*` (and `GET /stats`) | Operators | Inspect/update config, stats, audit prune, evaluation, and remote diagnostics | Yes, when using named CLI contexts |

```toml
[server]
hostname = "127.0.0.1"
auth_enabled = false
auth_token_env = "SKILLMUX_AUTH_TOKEN"
allowed_origins = []
max_body_bytes = 1048576
max_concurrent_requests = 100

[server.rate_limit]
enabled = false
requests_per_minute = 60
trust_proxy = false

[server.admin]
enabled = false
token_env = "SKILLMUX_ADMIN_TOKEN"
```

Defaults are loopback-only (`hostname = "127.0.0.1"`) with CORS deny-by-default (`allowed_origins = []`), so a zero-config `skillmux serve --transport http` is not reachable from the network or from a browser tab on another origin. Docker sets `hostname` to `0.0.0.0` automatically (`RUNNING_IN_DOCKER=true`) since port-mapping needs the container to accept connections on all interfaces.

`max_body_bytes` (default 1 MiB) and `max_concurrent_requests` (default 100) are positive resource bounds on the `--transport http` listener: unlike `rate_limit`, which is opt-in and off by default, these apply out of the box so the transport is never unbounded by omission. A request whose body exceeds `max_body_bytes` is rejected with `413 Payload Too Large` before it's fully read; once `max_concurrent_requests` requests are in flight, an additional request is rejected with `503 Service Unavailable`. Both are unrelated to `rate_limit`, which bounds request *count* per client over time rather than body size or concurrency.

Before exposing HTTP beyond localhost, set `hostname` to a reachable interface, `auth_enabled = true` with a token, and populate `allowed_origins` with the specific origins that need browser access. `rate_limit.trust_proxy` should stay `false` unless a trusted reverse proxy sets `X-Forwarded-For`: it's otherwise a client-controlled, spoofable header, and trusting it defeats per-client rate limiting.

`server.auth_token_env` names the MCP token for AI clients calling `/mcp`.
`server.admin.token_env` names a distinct administrative token for operators
calling `/admin/v1/*` when that API is enabled. Do not reuse or imply either
token authorizes the other surface. Named CLI contexts use the administrative
token to inspect or update the deployed server configuration only; they cannot
install, pin, synchronize, or otherwise manage remote client skill directories.
Docker images likewise do not manage host agent directories.
Inside the server image, only read-only `config show`, `get`, `validate`,
`diff`, and `status` are available. Run `config init` or `config set` with the
host CLI; the image returns `CONTAINER_COMMAND_UNSUPPORTED` with the exact host
command to run. See [Deployment](deployment.md#container-command-contract).

## Secret redaction and the admin audit trail

Skillmux redacts resolved credential values before they can reach CLI
output or server logs. Every `*_env`-suffixed config key (`api_key_env`,
`token_env`, `auth_token_env`) names an environment variable rather than
storing the secret itself; when an error message would otherwise embed that
variable's current value — or a credential typed directly into a URL, e.g.
`https://user:TOKEN@host/repo.git` for private-repo git auth — it is
replaced with `[REDACTED]` before the CLI's error handler or the server's
exception logging writes it out. This applies in both human and `--json`
output and requires no configuration; with no `*_env` keys set, it is a
no-op.

Every successful `PATCH /admin/v1/config` mutation appends one row to an
`admin_audit` table in the same `audit.sqlite3` used for fetch/resolve
telemetry, recording the timestamp, changed keys with their old and new
values, and the resulting config revision hash. A rejected request (stale
`If-Match`, read-only config) writes no row. Each row's hash is chained to
the previous row's hash, so any row deleted or edited outside the running
server breaks the chain — detectable by walking the table and recomputing
the chain, without a dedicated query endpoint. `admin_audit` rows are
pruned by the same `[audit] retention_days` setting as the rest of
`audit.sqlite3`; there is no separate retention config for admin history.

## Egress allowlist

```toml
[egress]
allowed_hosts = ["github.com"]
```

Unset by default, matching Skillmux's opt-in security posture elsewhere.
When set, `skillmux install` and `skillmux update` refuse to fetch from any
git host not on the list, checked before the network call — see
[Managing skills](skill-management.md#restrict-which-hosts-install-and-update-can-reach).
`file://` sources are exempt (no network egress occurs; they're already
gated by `--allow-local-source`), and host matching is exact and
case-insensitive, with no glob support.

The same `allowed_hosts` list also gates remote-inference calls: when set,
a `[inference.embedding]` or `[inference.reranker]` `endpoint` host not on
the list is rejected before the HTTP request, surfaced the same way as any
other embedding/reranker configuration error (`resolve_skill` degrades to
the strongest available retrieval lane rather than failing outright). This
does not apply to `inference.mode = "local"`, which never makes a network
call.

## Tiers and the manifest

`skillmux init` and `skillmux sync` manage native delivery by pinning selected
skills as symlinks inside an agent's skill directory. Routed skills remain
available through `resolve_skill`. Read [Concepts](concepts.md#delivery-tiers)
for the model and [Managing skills](skill-management.md) for the workflow.
This section defines the manifest.

### `skillmux.toml`

Lives at the vault root (a legacy `skr.toml` is still read if present, never written):

```toml
[core]
skills = ["csv-formatter"]           # pinned into every [targets.*] dir; capped at 25

[project.repo1]
paths = ["/Users/you/code/repo1"]    # only synced for paths that exist locally
skills = ["pdf-extractor"]           # must not overlap [core]

[targets.claude-code]
dir = "/Users/you/.claude/skills"
host = "workhorse"                    # optional; init adds the current hostname
project_groups = ["repo1"]           # which [project.*] groups materialize into this target; [] means none
```

- `[core].skills`: symlinked into every `[targets.*]` dir on `sync`. Capped at 25 skills; `sync` fails if a listed skill id isn't actually in the vault.
- `[project.<group>].skills`: symlinked only into `<path>/<relative path from $HOME to the target dir>`, for each `paths` entry, and only for targets whose `project_groups` names that group. `paths` entries must resolve under `$HOME` (that's how the pin path is derived). A skill can't appear in both `[core]` and the same `[project.*]` group.
- `[project.<group>].paths` can list the same project's checkout on more than one machine (e.g. `["/home/alice/code/repo1", "/Users/alice/code/repo1"]`). `sync` silently skips any entry that doesn't exist on the machine it's running on (see below), so one shared manifest can span machines with different checkout locations without needing per-machine manifests.
- `[targets.<name>]`: one entry per adopted surface. `skillmux init --target <name> --yes` writes these and scopes newly added targets to the current hostname. Hand-editing is fine as long as `sync` is still allowed to own the directory (see below). An optional `host` limits the target to an exact machine-hostname match; omit it for a global, backward-compatible target. A host mismatch is reported and skipped before any target filesystem operation. `project_groups` is an explicit list, not a boolean: a target only receives the specific groups it names, never every group in the manifest.

**Pin/unpin without hand-editing.** `skillmux core pin`/`unpin` mutate `[core]` for you, and `skillmux project pin`/`unpin` mutate `[project.*]`, validating with the same rules `sync` enforces (skill must resolve from `vault_path`, no duplicate pins, `[core]` stays under the 25-skill cap) before writing anything:

```sh
skillmux core pin csv-formatter --yes                                    # add to [core]
skillmux core pin csv-formatter pdf-extractor terraform-plans --yes      # pin several skills to [core] in one atomic call
skillmux project pin repo1 pdf-extractor --yes                           # add to an existing group
skillmux core unpin csv-formatter --yes                                  # remove from [core]
skillmux core unpin csv-formatter pdf-extractor --yes                    # unpin several skills from [core] in one atomic call
skillmux project unpin repo1 pdf-extractor --yes                         # remove from a group (group stays, even if empty)
```

Both commands accept one or more `skill_id` arguments per call; all of them are validated and applied against a single in-memory manifest before anything is written, so if any one of them is already pinned elsewhere (or, for unpin, not currently pinned), the whole call fails and the manifest file is left untouched: no partial pins. To pin into a `[project.<group>]` tier that doesn't exist yet, create it first with `skillmux project add-path <group> <path> --yes`. Hand-editing `skillmux.toml` directly is still fully supported; these commands are a convenience layer over the same file, not a replacement for it.

> **Breaking change:** `skillmux manifest pin`/`unpin` is removed. `[core]` pinning is now `skillmux core pin`/`unpin`; `[project.*]` pinning was already available as `skillmux project pin`/`unpin` and is now the only way to do it. There's no more `--path`-based inline group creation from a pin call; use `project add-path` to create the group first.
>
> **Breaking change:** `[targets.<name>].project` (a boolean) has been replaced by `project_groups` (an array of `[project.*]` names). A manifest still using the old field fails to parse with an error pointing at the new one. To migrate, replace `project = true` with `project_groups = [...]` listing every group that target previously received (previously *all* groups, unconditionally); replace `project = false` with `project_groups = []`.
>
> **Breaking change:** `[project.<group>].repos` has been renamed to `paths`. It was never required to be a git repository, just a local directory, and the old name collided in meaning with `skillmux install <repo>`'s unrelated git-source `repo` concept. A manifest still using `repos` fails to parse with an error pointing at `paths`; migrate by renaming the key (values are unchanged).

Every `[core]`/`[project.*]` skill_id must resolve from the configured
`vault_path` checkout. Pinning a skill that only exists in a
`local_vault_paths` entry (see below) fails `sync` with a distinct error, since
the manifest is meant to be portable across machines and a machine-local
override wouldn't exist elsewhere. `doctor` validates the manifest as part of
its checks, surfacing any violation without writing anything back.

### Ownership marker

Every directory `sync` manages gets a versioned `.skillmux` marker. A target
marker records `schema_version: 1`, `managed_by: "skillmux"`, `role:
"target"`, its target name, `vault_path`, `created_at`, and
`managed_entries`. The last field is the exact list of directory entries
Skillmux created. Sync removes only those tracked entries, preserves unrelated
content, and rejects a desired skill that collides with an unmanaged entry
before changing anything.

`sync` refuses to touch a directory that exists but has no marker; run
`skillmux init --target <name> --yes` first, which either creates the
directory fresh or adopts an existing one in place (contents untouched).
`sync --restore-monolith` likewise refuses a `local_vault` marker or any
unmanaged target content before replacing a target directory with a symlink
to the vault.

The same `.skillmux` filename is used for `local_vault_paths` entries (see
below), distinguished by `role: "local_vault"` and never accepted as target
ownership. Legacy unversioned markers are read for compatibility. An empty
legacy target is upgraded safely on its next sync; one containing untracked
entries is rejected with a migration diagnostic because their ownership
cannot be inferred.

### Local vault overlays

`local_vault_paths` (in `config.toml`, alongside `vault_path`) lets one machine layer override-only skills on top of the shared vault (a skill being authored locally, a machine-specific script, or a patched copy of an upstream skill) without touching `vault_path` itself:

```toml
vault_path = "~/skills"                 # configured checkout; owns skillmux.toml and the sync git hook
local_vault_paths = ["~/skills-local"]   # optional, default []: override-only, checked first
```

- **Resolution order**: for any given `skill_id`, `local_vault_paths` entries are checked first, in array order; `vault_path` is the fallback. This applies everywhere a skill's on-disk location matters: indexing, `resolve_skill`/`fetch_skill` delivery, and `sync`'s symlink target.
- **`vault_path` keeps its exact existing meaning.** `skillmux.toml` and the `sync --install-hook` git hook only ever live in `vault_path`; `skillmux doctor` warns if it finds a stray manifest inside a `local_vault_paths` entry instead.
- **`[core]`/`[project.*]` pins must resolve from `vault_path`.** Since the manifest is meant to be portable, `sync`/`doctor` reject a pin backed only by a `local_vault_paths` entry; see the manifest section above.
- **Not yet covered**: `startVaultWatcher`'s live filesystem watch still only watches `vault_path`; a change inside a `local_vault_paths` entry is picked up lazily (on the next `resolve_skill`/`fetch_skill`/`sync` call, via the same mtime staleness check `vault_path` already uses), not instantly.

**Visibility.** A `skill_id` present in more than one root is silently resolved via the precedence above with no output during normal use. Two commands make that resolution visible on demand:

- `skillmux skill which <skill_id>`: prints which root actually serves that skill, and names every root it shadows:
  ```
  $ skillmux skill which my-skill
  my-skill: serving from /home/user/skills-local
    shadows: /home/user/skills
  ```
  Exits non-zero with `<skill_id>: not found in vault_path or local_vault_paths` if no root has it.
- `skillmux doctor` reports every shadowed skill_id as an informational check (`shadowed:<skill_id>`, always `ok`) alongside its existing vault/manifest/embedding checks, so a scan of `doctor` output surfaces every override in one place, not just the one you thought to ask about.

**Discoverability.** A `local_vault_paths` entry is otherwise just a bare directory. Nothing on disk says it belongs to skillmux or which `vault_path` it overlays. `skillmux local-vault init <path>` writes a `.skillmux` marker recording that relationship:

```sh
skillmux local-vault init ~/skills-local
# wrote /home/user/skills-local/.skillmux (role: local_vault, vault_path: /home/user/skills)
```

`<path>` must already be one of the configured `local_vault_paths` entries and must exist on disk; the command only ever writes the marker, it never adds the path to `config.toml` for you. `skillmux doctor` reports each entry's marker status (`local_vault_marker:<path>`): `ok: false` if no marker exists yet (with the exact `local-vault init` command to fix it), or if the marker's recorded `vault_path` no longer matches the one currently configured (drift: e.g. after copying the directory to a machine with a different `vault_path`).
