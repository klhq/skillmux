# CLI reference and automation

The Bun package and standalone Linux executable expose the same Skillmux CLI.
For Linux installation, use the [pinned checksum-verified download](getting-started.md#install-the-cli)
or, when provenance verification is required, the
[attested GitHub CLI path](getting-started.md#install-with-github-cli-attestation).
Native management belongs on the machine that owns the client skill directories:
use the built-in `local` target for `init`, `install`, pinning, and `sync`.
Named remote contexts administer shared-server configuration through its
administrative API only; they do not install, pin, synchronize, or otherwise
manage skill directories on remote client machines.

In this guide, **local target** means the filesystem and process selected by
the built-in CLI context. It does not describe local inference. A local target
can call remote inference endpoints.

Run `skillmux --help` for the full command list, or `skillmux <command> --help`
(`-h` also works) for one command's usage and flags.

For task-oriented workflows, start with [Getting started](getting-started.md)
or [Managing skills](skill-management.md).

## Running inside the Skillmux server image

The Docker image is a shared-server runtime, not a replacement for the host
CLI. Its `skillmux --help` surface is intentionally limited to `serve`,
`index`, `doctor`, `report`, `audit prune`, `eval promote`, `scan`,
`skill which`, and read-only `config` inspection (`show`, `get`, `validate`,
`diff`, and `status`). Run `init`, `install`, pinning, `sync`, project or
target management, model downloads, contexts, and bare `eval` (vault ranking
evaluation, which needs an embeddings client and the vault) on the host.

When the image rejects one of those commands, it exits with code 2. JSON mode
uses `CONTAINER_COMMAND_UNSUPPORTED` and includes `rejected_command`,
`recommended_host_command`, and a deployment-guide URL. See [the container
command contract](deployment.md#container-command-contract) for examples.

## Local-only commands and remote context rejection

Commands that operate directly on the local vault checkout reject `--context` and
`--server` (or a configured remote default context) with exit code 2. These 14
commands are local-only: `install`, `update`, `outdated`, `sync`, `core`,
`project`, `target`, `local-vault`, `index`, `models`, `scan`, `init`, `serve`,
and `skill which`.

When one of these commands receives a remote context, it exits with code 2.
Human-mode output reports:

```
error: `<command>` operates on the local vault only; --context/--server isn't supported here
```

In `--json` mode, the CLI emits a structured error envelope with `code: "REMOTE_CONTEXT_UNSUPPORTED"`
and includes `rejected_command`.

## Global options and target resolution

Every target-aware command resolves its execution target deterministically in this order:

1. Explicit flags: `--context <name>` or `--server <url>`
2. Environment variables: `SKILLMUX_CONTEXT` or `SKILLMUX_SERVER`
3. Default context configured in `~/.config/skillmux/contexts.toml`
4. Built-in `local` context

> [!IMPORTANT]
> Supplying both `--context` and `--server` (or both `SKILLMUX_CONTEXT` and `SKILLMUX_SERVER`) is rejected as ambiguous. Plaintext HTTP admin targets on non-loopback addresses are rejected unless `--allow-insecure` is supplied.

| Flag | Description |
|------|-------------|
| `--context <name>` | Select a target context stored in `contexts.toml` |
| `--server <url>` | Select an explicit remote server URL |
| `--json` | Emit line-stable JSON envelopes (schema version 1) to stdout |
| `--allow-insecure` | Allow plaintext HTTP admin requests to non-loopback addresses |
| `--verbose` | Output diagnostic stack traces for errors |

`--context`/`--server` selects which Skillmux admin instance a command talks to
over `/admin/v1/*` — nothing more. That's one of three independent axes in this
system:

1. Which vault checkout backs Core/Project pinning — always a local Git checkout
   on the machine running the CLI. `install`/`update`/`sync`/`core`/`project`/
   `target`/`local-vault`/`index`/`models`/`scan`/`init`/`outdated`/`serve`/
   `skill which` operate on it. There is no remote version of this — Git and the
   deployment process move content between checkouts, not Skillmux's own
   commands.
2. Which MCP server an agent queries for Routed retrieval — the agent's own MCP
   client configuration (local stdio vs. remote HTTP), entirely separate from
   `skillmux context`.
3. Which Skillmux instance the CLI's admin commands act on — `config`, `report`,
   `audit prune`, `eval`/`eval promote`, and `doctor`. This is the only thing
   `--context`/`--server` actually selects.

The commands above belong entirely to axis 1. `--context` has no meaning for
them — not "risky," a category error, the same way `--context prod` wouldn't
mean anything on `ls`.

---

## Context management (`skillmux context`)

Contexts store named deployed-server targets without embedding raw credentials.
An associated token environment variable name (`token_env`) supplies only the
administrative bearer token; it is not an MCP token and cannot authenticate an
AI client to `/mcp`.

```sh
# List all configured contexts (includes reserved 'local' context)
skillmux context list

# View the currently active context
skillmux context current

# Add a remote context
skillmux context add prod --server https://skillmux.internal:3000 --token-env PROD_ADMIN_TOKEN

# Switch default context
skillmux context use prod

# Remove a context (reserved 'local' context cannot be removed)
skillmux context remove prod
```

---

## Configuration management (`skillmux config`)

Local and remote targets share the server configuration read and status
subcommands. `config init` is local-only because it creates machine
configuration and selects a local vault.

```sh
# Create the machine config after validating a populated vault
skillmux config init --vault ~/skills --yes

# View current configuration and source attribution (default, toml, environment)
skillmux config show

# Get a specific schema-known dotted key value
skillmux config get recall.k_lexical

# Validate effective configuration schema and runtime readiness
skillmux config validate

# View effective configuration diff against defaults
skillmux config diff

# Set a dotted key value (previews diff and validates before saving)
skillmux config set recall.k_lexical 30

# Perform dry-run validation without writing or activating changes
skillmux config set recall.k_lexical 30 --dry-run

# Inspect runtime status, deployment identity, revision hashes, and readiness
skillmux config status
```

`config status` reports the service runtime separately from the deployment
identity: `runtime` says whether the target is running, while
`deployment_runtime` and `image_variant` match `doctor` and `/health/ready`.
The JSON response contains no credential, API-key, or token values.

`config init` writes only `vault_path`. It leaves an existing config unchanged
and does not add `local_vault_paths`. Remote contexts administer the deployed
server configuration; they never administer client skill installation, pins,
sync, or any other remote-client directory operation.

---

## Setup planner (`skillmux init`)

Run `skillmux init` with no arguments in a terminal to start guided setup.
Skillmux preselects clients it can detect from filesystem evidence, asks for
core skills, prints one complete review, and applies after one confirmation.
The prompt stays line-oriented and does not use an alternate terminal screen.

Select clients by product name:

```sh
skillmux init --client claude-code --client codex --core csv-formatter --dry-run
skillmux init --client claude-code --client codex --core csv-formatter --yes
```

Skillmux supports these client IDs:

| Client | Skill delivery |
|--------|----------------|
| `claude-code` | `~/.claude/skills` |
| `codex` | `$CODEX_HOME/skills`, falling back to `~/.codex/skills` |
| `gemini-cli`, `opencode`, `github-copilot`, `windsurf` | Shared `~/.agents/skills` surface |
| `antigravity` | `~/.gemini/config/skills` |
| `goose`, `hermes` | Manual full-vault configuration |
| `skillmux-mcp` | Manual MCP registration |

Direct target IDs are `agent-skills`, `claude-code`, `codex`, and `custom`.
Custom targets require `--dir <dir>`. The legacy `agents` and `claude` IDs
print deprecation warnings and retain their manifest names.

`--dry-run` prints the config, target, instruction, and core plan without
prompting or writing. `--json` emits one schema-versioned plan or result
object. Noninteractive writes require `--yes`. `--interactive` forces the
wizard and seeds it with supplied flags. `--no-instructions` skips managed
instruction files; `--no-sync` saves setup without materializing links.

Skillmux rejects a target that currently links to the whole vault. Convert it
only after reviewing the smaller post-sync skill set:

```sh
skillmux init --client claude-code --migrate-full-vault \
  --core csv-formatter --dry-run
skillmux init --client claude-code --migrate-full-vault \
  --core csv-formatter --yes
```

Client instruction adapters append one managed discovery block and preserve
the rest of each file. Skillmux uses `.hermes.md` for Hermes and refuses
`SOUL.md` or Hermes's installed-source `AGENTS.md`. A client without a safe
user-level convention reports manual setup.

---

## Project setup (`skillmux project init`)

Run the guided flow from a project directory:

```sh
skillmux project init
```

Skillmux resolves the project directory from an explicit positional path, then
the current Git root, then the current directory. It suggests the directory
basename as the project-group name.

The noninteractive form accepts repeatable client and skill flags:

```sh
skillmux project init ~/code/skillmux \
  --name skillmux \
  --client claude-code \
  --client codex \
  --skill sdd-tdd \
  --skill code-context \
  --yes
```

`--client` maps product names to configured, deduplicated targets. Advanced
callers can attach a configured target with repeated `--target <name>`.
Re-running the command merges missing paths, skills, and target attachments.
It validates the complete manifest before an atomic write and runs `sync` by
default. Use `--no-sync` when another process will materialize the links.

Direct project commands support later maintenance:

```sh
skillmux project list
skillmux project show skillmux
skillmux project add-path skillmux ~/code/skillmux --yes
skillmux project remove-path skillmux ~/old/skillmux --yes
skillmux project pin skillmux sdd-tdd code-context --yes
skillmux project unpin skillmux old-skill --yes
skillmux project attach skillmux --client claude-code --client codex --yes
skillmux project detach skillmux --target codex --yes
```

`add-path` and `remove-path` detect the current Git root when the path is
omitted. Client attachments map to configured physical targets and deduplicate
clients that share `~/.agents/skills`. Mutating commands validate the complete
manifest and replace it atomically. Run `skillmux sync` after direct
maintenance commands to materialize the new state.

---

## Advanced targets (`skillmux target`)

Most users should select products with `init --client`. Use `target` commands
for custom delivery directories and manifest inspection:

```sh
skillmux target list
skillmux target show claude-code
skillmux target add custom-agent --dir /srv/custom-agent/skills --yes
skillmux target remove custom-agent --yes
```

`target add` uses the same ownership, symlink, full-vault, rollback, and
current-host scoping checks as `skillmux init`. `target remove` removes the
manifest entry and preserves the directory, marker, and skill files. The
command prints the preserved path so cleanup remains an explicit user action.

---

## Core skills (`skillmux core`)

Pin or unpin skills into `[core]`, the tier every target receives by
default, capped at 25 skills:

```sh
skillmux core pin csv-formatter --yes
skillmux core pin csv-formatter pdf-extractor terraform-plans --yes
skillmux core unpin csv-formatter --yes
```

One or more `skill_id` arguments are accepted per call and applied
atomically against a single in-memory manifest: if any one of them is
already pinned elsewhere (or, for `unpin`, not currently pinned), the
whole call fails and the manifest file is left untouched. To pin into a
`[project.<group>]` tier instead, use `skillmux project pin` (see
[Project Setup](#project-setup-skillmux-project-init)).

### Reloadable and restart-required keys

Config changes are categorized into live-reloadable and restart-required settings:

- **Reloadable**: `config.environment_overrides`, `vault_path`, `recall.k_lexical`, `recall.k_vector`, `recall.k_rerank`, `output.top_k`, `output.max_top_k`, `inference.embedding.endpoint`, `inference.embedding.api_key_env`, `inference.reranker.adapter`, `inference.reranker.endpoint`, `inference.reranker.model`, `inference.reranker.api_key_env`, `inference.timeout_ms`, `server.rate_limit.enabled`, `server.rate_limit.requests_per_minute`, `server.rate_limit.trust_proxy`
- **Restart Required**: `server.hostname`, `server.auth_enabled`, `server.auth_token_env`, `server.admin.enabled`, `server.admin.token_env`, `inference.mode`, `inference.bundle`, `inference.models_dir`, `state_dir`, `inference.embedding.model`, `inference.embedding.dimension`, `inference.embedding.device`, `inference.embedding.dtype`

The config file is optional. `skillmux serve` starts with defaults if its
config path or parent directory is absent. In that case reload is inactive
until a restart finds a watchable parent directory; malformed updates to an
active watched config are reported without replacing the last known good values.

---

## Skill introspection (`skillmux skill which`)

Show which root actually serves a skill_id, and every root it shadows:

```sh
skillmux skill which csv-formatter
```

> [!NOTE]
> `skill which` performs local vault-checkout shadow resolution (which root
> wins on the local filesystem) and is unrelated to semantic MCP skill routing
> (`resolve_skill`/`fetch_skill`).

---

## Observability and evaluation (`skillmux report`, `audit`, `eval`)

`resolve_skill` records every request to an audit log; `fetch_skill` records
what was actually opened and, when the caller passes back the `request_id`
from a prior resolve, correlates the fetch to that resolve and its rank in
the shortlist. `skillmux report` summarizes this data, `skillmux audit prune`
reclaims space, and `skillmux eval promote` turns correlated fetches into
eval cases.

```sh
# Summarize activity from the local state or a remote server
skillmux report --since 7d
skillmux report --server https://skillmux.internal:3000 --since 24h
skillmux report --db ~/.local/state/skillmux/audit.sqlite3 --since 2026-08-01

# Prune audit rows older than the configured retention window (default 90 days)
skillmux audit prune --yes
skillmux audit prune --older-than 30d --dry-run
skillmux audit prune --older-than 30d --json

# Promote observed, correlated fetches into an eval case file
skillmux eval promote --since 7d --dry-run
skillmux eval promote --since 7d --yes
skillmux eval promote --since 7d --target eval/observed.json --yes
```

`report` reads `--server <url>`, `--db <path>` (an explicit SQLite file,
opened read-only), or the configured local `state_dir` by default;
`--server` and `--db` are mutually exclusive. Alongside request totals,
empty-shortlist rate, retrieval-lane totals, degradation counts, and
per-skill candidate counts, `report` prints an acceptance signal derived
from correlated fetches: `acceptance_rate`, `observed_mrr` (reciprocal rank
of the first fetched candidate), and `top1_acceptance_rate`, each computed
over resolves that returned at least one candidate. When a window has no
correlated fetches, `report` marks the signal `unavailable` and states the
uncorrelated fetch count instead of printing a misleading `0.000`. It also
lists the top queries that returned candidates but received no correlated
fetch, distinct from the existing top empty-shortlist list.

`audit prune` deletes resolve and fetch rows older than `--older-than` (same
window syntax as `--since`), or `audit.retention_days` from configuration
(default 90; `0` disables pruning). `--dry-run` reports counts without
writing. Non-interactive runs require `--yes`. The server also prunes
automatically once at startup and at most once per 24 hours while running;
manual pruning is for on-demand cleanup or a tighter window.

`eval promote` reads correlated fetches since `--since`, deduplicates them by
normalized query, and writes `{ query, split: "observed", relevant_skill_ids
}` cases to `--target` (default an `eval-observed.json` file under
`state_dir`; never the hand-curated `eval/queries.json` unless given
explicitly). It never rewrites a case for a query already present in the
target file; skipped counts are reported in the summary. Because promoted
cases carry raw user queries, `eval promote` always prints a stderr warning.
Both `--dry-run` and `--yes` behave as elsewhere in the CLI.

---

## Administrative HTTP API (`/admin/v1/*`)

The HTTP server has two separate surfaces:

| Surface | User | Purpose | CLI required |
| --- | --- | --- | --- |
| `/mcp` | AI clients | Resolve and fetch skills | No |
| `/admin/v1/*` (and `GET /stats`) | Operators | Inspect/update config, stats, audit prune, evaluation, and remote diagnostics | Yes, when using named CLI contexts |

The MCP bearer token applies only to `/mcp`. The administrative bearer token
below applies only to `/admin/v1/*` (and `GET /stats`); neither credential grants access to the
other surface. Named contexts use the latter to administer the deployed server,
not any remote client skill directory.

Remote servers expose administrative control endpoints under `/admin/v1/*` when enabled in configuration:

```toml
[server.admin]
enabled = true
token_env = "SKILLMUX_ADMIN_TOKEN"
```

Requests require `Authorization: Bearer <token>` where `<token>` matches the environment variable named by `server.admin.token_env`.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/admin/v1/capabilities` | `GET` | Advertises server features (`config_read`, `config_write`, `persistence`) |
| `/admin/v1/config` | `GET` | Returns desired/effective config, sources, and `ETag` revision hash |
| `/admin/v1/config` | `PATCH` | Applies dotted-key updates; requires matching `If-Match` header |
| `/admin/v1/audit/prune` | `POST` | Prunes audit/fetch/admin_audit rows older than cutoff; requires `confirm: true` unless `dry_run: true` |
| `/admin/v1/eval` | `POST` | Runs vault ranking evaluation server-side and returns `EvalReport` |
| `/admin/v1/eval/promote` | `POST` | Returns candidate promoted eval cases from the server's audit database; requires `since` |

### Remote command capabilities

Named CLI contexts (`--context <name>` or `--server <url>`) support the following administrative and diagnostic operations:

- `skillmux config` (`show`, `get`, `set`, `validate`, `diff`, `status`): inspect and modify remote server configuration over `/admin/v1/*`.
- `skillmux report --since <window>`: fetches usage and retrieval metrics from the remote server's `GET /stats`.
- `skillmux audit prune [--older-than <window>] [--dry-run] [--yes]`: prunes or dry-run counts audit records on the remote server via `POST /admin/v1/audit/prune`.
- `skillmux eval`: executes ranking evaluation against the remote server's in-process runtime via `POST /admin/v1/eval`.
- `skillmux eval promote --since <window>`: fetches promotable candidates from the remote server's audit db via `POST /admin/v1/eval/promote`, dedups against the local fixture file, and writes locally.
- `skillmux doctor`: inspects remote server status, readiness, deployment runtime, and capabilities without requiring local vault access.

---

## Automation and JSON output (`--json`)

When `--json` or `SKILLMUX_JSON=true` is set, all output is emitted to `stdout` in a stable envelope:

```json
{
  "schema_version": 1,
  "ok": true,
  "target": "local",
  "data": { ... },
  "error": null
}
```

### Exit codes

| Code | Meaning | Examples |
|------|---------|----------|
| `0` | Success | Command completed cleanly |
| `2` | Usage / Validation Error | Unknown key, malformed value, missing option, invalid command |
| `3` | Target Unreachable / Unauthenticated | Connection refused, HTTP 401 Unauthorized, HTTP 403 Forbidden |
| `4` | Conflict / Governance Gate | HTTP 409 `CONFIG_REVISION_CONFLICT` or `CONFIG_EXTERNALLY_MANAGED` |

---

## Shell completions (`skillmux completions`)

Generate tab-completions for `bash`, `zsh`, or `fish`:

```sh
# Bash
skillmux completions bash > ~/.local/share/bash-completion/completions/skillmux

# Zsh
skillmux completions zsh > ~/.zsh/completion/_skillmux

# Fish
skillmux completions fish > ~/.config/fish/completions/skillmux.fish
```
