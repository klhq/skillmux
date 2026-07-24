# Configuration

Skillmux defaults to FTS5 plus local GTE-small semantic retrieval. Most users need no config file.

For detailed CLI command reference, target resolution, policy calibration, and automation envelopes, see [`docs/cli.md`](cli.md).

## Machine config bootstrap

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

## Local mode

```toml
[inference]
mode = "local"
```

The versioned `gte-small-v1` bundle uses normalized, mean-pooled `Xenova/gte-small` embeddings (384 dimensions), quantized to q8 on CPU. Models are cached in `~/.cache/skillmux/models`. FTS5 and cosine result lists are combined with reciprocal-rank fusion; without a reranker the calling LLM selects from the ordered shortlist.

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

Use `skillmux models download` to prefetch models and `skillmux doctor` to verify readiness.

## Remote mode

See [`config.remote.example.toml`](../config.remote.example.toml). Embeddings must implement the OpenAI-compatible `POST /v1/embeddings` API. Optional reranking must implement Infinity's `POST /rerank` API. Credentials are read from the environment variables named by `api_key_env`.

Remote embedding `dimension` is required. Changing the provider, model, or dimension invalidates stored vectors and safely rebuilds them.

## Advanced retrieval

Candidate-generation depth is configurable but normally does not need tuning:

```toml
[recall]
k_lexical = 20
k_vector = 20

[thresholds]
candidate_limit = 5
```

The router considers up to 20 candidates from each retrieval lane but returns at most 5 to the calling LLM.

Reranker thresholds have no universal default because score distributions are model-specific. When configuring a reranker, provide calibrated `inference.thresholds.match_score`, `inference.thresholds.match_margin`, and `inference.thresholds.candidate_floor`; otherwise configuration is rejected rather than silently applying unsuitable values.

## HTTP server

```toml
[server]
hostname = "127.0.0.1"
auth_enabled = false
auth_token_env = "SKILLMUX_AUTH_TOKEN"
allowed_origins = []

[server.rate_limit]
enabled = false
requests_per_minute = 60
trust_proxy = false
```

Defaults are loopback-only (`hostname = "127.0.0.1"`) with CORS deny-by-default (`allowed_origins = []`) — a zero-config `skillmux serve --transport http` is not reachable from the network or from a browser tab on another origin. Docker sets `hostname` to `0.0.0.0` automatically (`RUNNING_IN_DOCKER=true`) since port-mapping needs the container to accept connections on all interfaces.

Before exposing HTTP beyond localhost, set `hostname` to a reachable interface, `auth_enabled = true` with a token, and populate `allowed_origins` with the specific origins that need browser access. `rate_limit.trust_proxy` should stay `false` unless a trusted reverse proxy sets `X-Forwarded-For` — it's otherwise a client-controlled, spoofable header and trusting it defeats per-client rate limiting.

## Tiers and the manifest

`skillmux init`/`sync` manage an optional second delivery path — pinning a subset of skills as real symlinks inside an agent's own skill directory, instead of routing every request through `resolve_skill`. See the README's [Tiers](../README.md#tiers-routed-vs-pinned) section for the concept and a walkthrough; this is the manifest reference.

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
project_groups = ["repo1"]           # which [project.*] groups materialize into this target — [] means none
```

- `[core].skills` — symlinked into every `[targets.*]` dir on `sync`. Capped at 25 skills; `sync` fails if a listed skill id isn't actually in the vault.
- `[project.<group>].skills` — symlinked only into `<path>/<relative path from $HOME to the target dir>`, for each `paths` entry, and only for targets whose `project_groups` names that group. `paths` entries must resolve under `$HOME` (that's how the pin path is derived). A skill can't appear in both `[core]` and the same `[project.*]` group.
- `[project.<group>].paths` can list the same project's checkout on more than one machine (e.g. `["/home/alice/code/repo1", "/Users/alice/code/repo1"]`) — `sync` silently skips any entry that doesn't exist on the machine it's running on (see below), so one shared manifest can span machines with different checkout locations without needing per-machine manifests.
- `[targets.<name>]` — one entry per adopted surface. `skillmux init --target <name> --yes` writes these and scopes newly added targets to the current hostname. Hand-editing is fine as long as `sync` is still allowed to own the directory (see below). An optional `host` limits the target to an exact machine-hostname match; omit it for a global, backward-compatible target. A host mismatch is reported and skipped before any target filesystem operation. `project_groups` is an explicit list, not a boolean — a target only receives the specific groups it names, never every group in the manifest.

**Pin/unpin without hand-editing.** `skillmux core pin`/`unpin` mutate `[core]` for you, and `skillmux project pin`/`unpin` mutate `[project.*]`, validating with the same rules `sync` enforces (skill must resolve from `vault_path`, no duplicate pins, `[core]` stays under the 25-skill cap) before writing anything:

```sh
skillmux core pin csv-formatter --yes                                    # add to [core]
skillmux core pin csv-formatter pdf-extractor terraform-plans --yes      # pin several skills to [core] in one atomic call
skillmux project pin repo1 pdf-extractor --yes                           # add to an existing group
skillmux core unpin csv-formatter --yes                                  # remove from [core]
skillmux core unpin csv-formatter pdf-extractor --yes                    # unpin several skills from [core] in one atomic call
skillmux project unpin repo1 pdf-extractor --yes                         # remove from a group (group stays, even if empty)
```

Both commands accept one or more `skill_id` arguments per call; all of them are validated and applied against a single in-memory manifest before anything is written, so if any one of them is already pinned elsewhere (or, for unpin, not currently pinned), the whole call fails and the manifest file is left untouched — no partial pins. To pin into a `[project.<group>]` tier that doesn't exist yet, create it first with `skillmux project add-path <group> <path> --yes`. Hand-editing `skillmux.toml` directly is still fully supported; these commands are a convenience layer over the same file, not a replacement for it.

> **Breaking change:** `skillmux manifest pin`/`unpin` is removed. `[core]` pinning is now `skillmux core pin`/`unpin`; `[project.*]` pinning was already available as `skillmux project pin`/`unpin` and is now the only way to do it — there's no more `--path`-based inline group creation from a pin call, use `project add-path` to create the group first.
>
> **Breaking change:** `[targets.<name>].project` (a boolean) has been replaced by `project_groups` (an array of `[project.*]` names). A manifest still using the old field fails to parse with an error pointing at the new one. To migrate, replace `project = true` with `project_groups = [...]` listing every group that target previously received (previously *all* groups, unconditionally); replace `project = false` with `project_groups = []`.
>
> **Breaking change:** `[project.<group>].repos` has been renamed to `paths` — it was never required to be a git repository, just a local directory, and the old name collided in meaning with `skillmux install <repo>`'s unrelated git-source `repo` concept. A manifest still using `repos` fails to parse with an error pointing at `paths`; migrate by renaming the key (values are unchanged).

Every `[core]`/`[project.*]` skill_id must resolve from the canonical `vault_path` — pinning a skill that only exists in a `local_vault_paths` entry (see below) fails `sync` with a distinct error, since the manifest is meant to be portable across machines and a machine-local override wouldn't exist elsewhere. `doctor` validates the manifest as part of its checks, surfacing any violation without writing anything back.

### Ownership marker

Every directory `sync` manages gets a versioned `.skillmux` marker. A target
marker records `schema_version: 1`, `managed_by: "skillmux"`, `role:
"target"`, its target name, `vault_path`, `created_at`, and
`managed_entries`. The last field is the exact list of directory entries
Skillmux created. Sync removes only those tracked entries, preserves unrelated
content, and rejects a desired skill that collides with an unmanaged entry
before changing anything.

`sync` refuses to touch a directory that exists but has no marker — run
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

`local_vault_paths` (in `config.toml`, alongside `vault_path`) lets one machine layer override-only skills on top of the shared vault — a skill being authored locally, a machine-specific script, or a patched copy of an upstream skill — without touching `vault_path` itself:

```toml
vault_path = "~/skills"                 # unchanged: canonical, owns skillmux.toml and the sync git hook
local_vault_paths = ["~/skills-local"]   # optional, default []: override-only, checked first
```

- **Resolution order**: for any given `skill_id`, `local_vault_paths` entries are checked first, in array order; `vault_path` is the fallback. This applies everywhere a skill's on-disk location matters — indexing, `resolve_skill`/`fetch_skill` delivery, and `sync`'s symlink target.
- **`vault_path` keeps its exact existing meaning.** `skillmux.toml` and the `sync --install-hook` git hook only ever live in `vault_path`; `skillmux doctor` warns if it finds a stray manifest inside a `local_vault_paths` entry instead.
- **`[core]`/`[project.*]` pins must resolve from `vault_path`.** Since the manifest is meant to be portable, `sync`/`doctor` reject a pin backed only by a `local_vault_paths` entry — see the manifest section above.
- **Not yet covered**: `startVaultWatcher`'s live filesystem watch still only watches `vault_path`; a change inside a `local_vault_paths` entry is picked up lazily (on the next `resolve_skill`/`fetch_skill`/`sync` call, via the same mtime staleness check `vault_path` already uses), not instantly.

**Visibility.** A `skill_id` present in more than one root is silently resolved via the precedence above with no output during normal use — two commands make that resolution visible on demand:

- `skillmux skill which <skill_id>` — prints which root actually serves that skill, and names every root it shadows:
  ```
  $ skillmux skill which my-skill
  my-skill: serving from /home/user/skills-local
    shadows: /home/user/skills
  ```
  Exits non-zero with `<skill_id>: not found in vault_path or local_vault_paths` if no root has it.
- `skillmux doctor` reports every shadowed skill_id as an informational check (`shadowed:<skill_id>`, always `ok`) alongside its existing vault/manifest/embedding checks — so a scan of `doctor` output surfaces every override in one place, not just the one you thought to ask about.

**Discoverability.** A `local_vault_paths` entry is otherwise just a bare directory — nothing on disk says it belongs to skillmux or which `vault_path` it overlays. `skillmux local-vault init <path>` writes a `.skillmux` marker recording that relationship:

```sh
skillmux local-vault init ~/skills-local
# wrote /home/user/skills-local/.skillmux (role: local_vault, vault_path: /home/user/skills)
```

`<path>` must already be one of the configured `local_vault_paths` entries and must exist on disk — the command only ever writes the marker, it never adds the path to `config.toml` for you. `skillmux doctor` reports each entry's marker status (`local_vault_marker:<path>`): `ok: false` if no marker exists yet (with the exact `local-vault init` command to fix it), or if the marker's recorded `vault_path` no longer matches the one currently configured (drift — e.g. after copying the directory to a machine with a different `vault_path`).
