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

For task-oriented workflows, start with [Getting started](getting-started.md)
or [Managing skills](skill-management.md).

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

# Inspect runtime status, revision hashes, and readiness
skillmux config status
```

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

Pin or unpin skills into `[core]` — the tier every target receives by
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

- **Reloadable**: `vault_path`, `recall.*`, `thresholds.*`, `inference.embedding.*`, `server.rate_limit.*`
- **Restart Required**: `server.hostname`, `server.auth_enabled`, `server.auth_token_env`, `server.admin.enabled`, `server.admin.token_env`, `inference.mode`, `state_dir`

---

## Skill introspection (`skillmux skill which`)

Show which root actually serves a skill_id, and every root it shadows:

```sh
skillmux skill which csv-formatter
```

---

## Policy calibration (`skillmux calibrate`)

Calibrate decision thresholds (`match_score`, `match_margin`, `candidate_floor`) against synthetic or labeled query datasets.
Calibration is local-only in this release. Remote targets advertise the
capability as unavailable and return `not_implemented`; a local dataset path is
never uploaded or represented as remotely executed. See
[`docs/calibration.md`](calibration.md) for dataset responsibilities,
certification gates, run evidence, reference values, and the complete operator
lifecycle.

```sh
# Run calibration on a dataset
skillmux calibrate run --dataset ./eval/queries.json

# List stored calibration runs in the evidence store
skillmux calibrate list

# Inspect detailed metrics and confusion matrix for a run
skillmux calibrate show <run_id>

# Apply calibrated thresholds to configuration (with fingerprint validation)
skillmux calibrate apply <run_id>

# Generate a synthetic decision dataset from vault skills
skillmux calibrate generate-dataset --out ./eval/queries.json
```

---

## Administrative HTTP API (`/admin/v1/*`)

The HTTP server has two separate surfaces:

| Surface | User | Purpose | CLI required |
| --- | --- | --- | --- |
| `/mcp` | AI clients | Resolve and fetch skills | No |
| `/admin/v1/*` | Operators | Inspect or update server configuration | Yes, when using named CLI contexts |

The MCP bearer token applies only to `/mcp`. The administrative bearer token
below applies only to `/admin/v1/*`; neither credential grants access to the
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
| `/admin/v1/capabilities` | `GET` | Advertises server features (`config_read`, `config_write`, `calibration`, `persistence`) |
| `/admin/v1/config` | `GET` | Returns desired/effective config, sources, and `ETag` revision hash |
| `/admin/v1/config` | `PATCH` | Applies dotted-key updates; requires matching `If-Match` header |
| `/admin/v1/calibrations` | `GET`, `POST` | Returns `501 not_implemented` (calibration is local-only) |
| `/admin/v1/calibrations/{run_id}` | `GET` | Returns `501 not_implemented`; raw evaluation queries are not exposed |
| `/admin/v1/calibrations/{run_id}/apply` | `POST` | Returns `501 not_implemented` |

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
