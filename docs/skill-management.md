# Managing skills

Skillmux keeps skill content in a vault checkout and materializes selected
skills into agent directories. The vault source of truth is the logical
collection; a checkout is its physical copy. This guide covers the commands
that change or inspect that state.

Run these commands on the machine that owns the vault checkout and agent
directories. For a retrieval-only Docker service, manage the mounted checkout
on the host and keep the container mount read-only; the server image does not
manage host agent directories.

## Install from Git

`skillmux install` accepts a GitHub shorthand or a full Git URL:

```sh
skillmux install owner/repo
skillmux install owner/repo/path/to/skill
skillmux install https://git.example.com/team/skill.git
```

The repository root must contain `SKILL.md`. If a repository contains several
skill directories, add the path for the one you want.

Skillmux clones into a temporary directory, validates the selected skill,
scans its text files, and copies it to `vault_path`. Existing skill IDs require
`--force`.

Nothing is written to the vault until you approve it. The scan result prints
first, then `install` asks for confirmation, so you decide with the findings
already on screen. Pass `--yes` to approve up front. A non-interactive run
(no TTY, or `--json`) fails instead of installing unattended, the same way
`skillmux update` behaves, so scripts and CI must opt in explicitly:

```sh
skillmux install owner/repo --yes
```

Preview the destination without copying. `--dry-run` writes nothing, so it
never asks for confirmation:

```sh
skillmux install owner/repo --dry-run
```

The scanner detects suspicious prompt-injection patterns, secrets, and risky
instructions. A high-severity finding aborts the install by default. Use
`--fail-on` to move that threshold, where a lower one is stricter, and
`--fail-on none` to install despite any finding:

```sh
skillmux install owner/repo --fail-on low     # also abort on low and medium
skillmux install owner/repo --fail-on none    # never abort on findings
```

`install` refuses a `file://` source by default — a `file://` URL reaches the
local filesystem directly, so honoring one unconditionally would let anything
that can hand `skillmux install` a string (a webpage, another tool's output,
an instruction an agent was told to follow) pull an arbitrary local
repository into the shared vault. Pass `--allow-local-source` when installing
from a local repo is a deliberate, interactive choice:

```sh
skillmux install file:///path/to/local/repo --allow-local-source
```

### Restrict which hosts install and update can reach

By default `install` and `update` will fetch from any git host. Set
`[egress] allowed_hosts` in your config to restrict both to an explicit list:

```toml
[egress]
allowed_hosts = ["github.com", "git.example.com"]
```

A host not on the list is rejected before any network fetch, for both a new
`skillmux install <source>` and a `skillmux update` re-fetching a skill's
recorded origin. This doesn't apply to `file://` sources, which never leave
the local filesystem and are already gated by `--allow-local-source` above.
Leaving `allowed_hosts` unset (the default) leaves both commands unrestricted.

## Scan a vault or candidate

```sh
skillmux scan
skillmux scan ~/skills/candidate
skillmux scan --json
skillmux scan --fail-on medium
```

With no path, `scan` checks the configured vault. `--json` wraps the result in
the standard CLI automation envelope.

Unlike `install` and `update`, `scan` has no default threshold: it reports
what it finds and exits 0 regardless, so adding it to a pipeline never
changes that pipeline's exit code by itself. Pass `--fail-on` when you want
it to gate. The value names the lowest severity that still fails, so a lower
value is stricter.

`--format text|json` is deprecated. It still works, but it prints JSON
outside the standard envelope and now warns on stderr. Use `--json` instead.

## Check and pull upstream updates

Every skill `install` places in the vault gets a `.skillmux-origin` sidecar
recording the source repo, resolved commit, and a content hash. Check which
installed skills have moved upstream:

```sh
skillmux outdated
skillmux outdated --json
```

Skills you authored by hand, or installed before this sidecar existed, carry
no `.skillmux-origin` and are silently omitted — `outdated` only reports on
skills it can trace back to a source. A repo that has become unreachable is
reported per-skill as `check_failed` with a reason; it does not stop the rest
of the check.

Pull an update for one skill, or every outdated skill at once:

```sh
skillmux update csv-formatter --dry-run
skillmux update csv-formatter --yes
skillmux update --yes
```

`--dry-run` reports the old and new commit and whether content actually
changed, without writing anything. A real update re-runs the same scan
`install` does (`--fail-on` applies the same way) and refuses to overwrite a
skill whose on-disk content has drifted from what was last installed —
someone may have hand-edited it. Pass `--force` to overwrite anyway. Like
`audit prune`, a non-interactive or `--json` run needs `--yes`.

## Plan agent delivery

Use product names for common agents:

```sh
skillmux init --agent claude-code --agent codex --dry-run
```

For a directory that isn't tied to any supported agent, use `target add`
directly instead of `init`:

```sh
skillmux target add my-agent --dir /srv/my-agent/skills --yes
```

Skillmux refuses to adopt a target that points to the whole vault because sync
would reduce its visible skills. Review that migration first:

```sh
skillmux init --agent claude-code --migrate-full-vault \
  --core csv-formatter --dry-run
skillmux init --agent claude-code --migrate-full-vault \
  --core csv-formatter --yes
```

## Manage core pins

Core skills go to each configured target:

```sh
skillmux core pin csv-formatter --yes
skillmux core pin code-context systematic-debugging --yes
skillmux core unpin csv-formatter --yes
```

One command can change several skill IDs. Skillmux validates the complete
change before writing, so a conflict prevents the whole operation. Core stays
capped at 25 skills.

Run `skillmux sync` after a direct pin or unpin command.

## Manage project groups

Create a group with the guided command:

```sh
skillmux project init
```

Maintain it with explicit commands:

```sh
skillmux project list
skillmux project show my-project
skillmux project add-path my-project ~/code/my-project --yes
skillmux project pin my-project code-context --yes
skillmux project attach my-project --agent claude-code --agent codex --yes
skillmux project unpin my-project code-context --yes
skillmux project detach my-project --target codex --yes
skillmux project remove-path my-project ~/code/my-project --yes
```

Create the group with `project init` or `project add-path` before pinning.
Project setup syncs by default. Direct maintenance commands update the
manifest but leave materialization to the next `skillmux sync`.

## Synchronize targets

```sh
skillmux sync --dry-run
skillmux sync
```

Sync compares the manifest with entries recorded in each target's `.skillmux`
marker. It creates missing symlinks and removes stale managed links.

Install a vault-checkout Git hook when merges can change `skillmux.toml`:

```sh
skillmux sync --install-hook
```

The hook lives in the configured vault checkout and runs `skillmux sync` after
a merge. Git and your deployment process, not Skillmux, keep separate
checkouts replicated and fresh.

## Inspect active state

Find which vault root serves a skill:

```sh
skillmux skill which code-context
```

If a local overlay shadows the configured checkout's copy, the output lists
both paths.

Inspect configuration and readiness:

```sh
skillmux config show
skillmux config diff
skillmux config status
skillmux doctor
```

## Use routing data to tune tiers

`resolve_skill` writes an audit row for each request. Summarize recent usage:

```sh
skillmux report --since 7d
skillmux report --server http://host:3000 --since 7d
skillmux report --context prod --since 7d
```

`skillmux report` aggregates total requests, empty shortlist count and rate,
retrieval totals across lanes (`exact`, `reranked`, `hybrid`, `lexical`), degraded
request counts, average latency in milliseconds, per-skill `candidate_count`, and
`top_empty_shortlist_queries`.

Skills with high candidate counts may belong in `[core]` or a project group.
Top empty shortlist queries point to missing skills or weak skill descriptions.

`--since` accepts windows such as `1h`, `7d`, and `1m`, plus absolute dates and
timestamps.

Register a remote deployment once with `skillmux context add`, then reuse it by
name instead of retyping `--server` (and, if the deployment requires
authentication, its token) on every call:

```sh
skillmux context add prod --server http://host:3000 --token-env SKILLMUX_AUTH_TOKEN
skillmux report --context prod --since 7d
```

`--context` and bare `--server` both hit `GET /stats` on the target and require
an HTTP transport listening there. A stdio-only deployment (the common case
for an MCP server spawned by a host over stdin/stdout) has no such listener by
default. Give it a narrow, read-only one — just `/health` and `/stats`, none
of the MCP tool surface — without switching its primary transport:

```sh
skillmux serve --transport stdio --stats-port 4317
```

The stats port inherits the same `[server]` bind-posture rule as the `http`
transport (see [Configuration](configuration.md#http-server)): binding it
to anything other than a loopback address requires `server.auth_enabled =
true` with a token, or it refuses to start. `--stats-port` is rejected
alongside `--transport http`, since that transport already serves `/stats` on
`--port`.

`--context`/`--server` work the same way for `audit prune`, `eval`, `eval
promote`, and `doctor` — each hits the matching `/admin/v1/*` route on the
named deployment instead of the local vault and audit db. See [CLI
reference](cli.md#administrative-http-api-adminv1) for the full remote
command surface and route table.

## Target ownership and recovery

`skillmux target remove <name> --yes` removes the manifest record and preserves
the target directory, marker, and files. Cleanup stays under your control.

Built-in targets (`agent-skills`, `claude-code`, and `codex`) resolve their
native directories from their names. Their manifest entries store only host and
project-group configuration. Custom targets retain an explicit `dir`. To remove
legacy built-in `dir` fields without changing any target files, run
`skillmux target migrate --dry-run` and then `skillmux target migrate --yes`.

When a managed target's marker still names a previous vault checkout after a
vault move, use `skillmux target rehome <name> --yes`. It validates every
recorded managed symlink in the target and its existing project pins before
updating their `.skillmux` markers to the configured `vault_path`. Use
`--dry-run` first to inspect the marker paths. Rehome never creates or removes
skill links. It retargets a link only when it resolves exactly to the previous
`vault_path` recorded in its marker, and it refuses legacy markers or any link
that cannot be proven to belong to either the previous or configured vault.

Restore a managed target to one symlink that exposes the full vault:

```sh
skillmux sync --restore-monolith
```

This operation removes the target marker and per-skill links. It refuses to
run when unmanaged content makes the replacement unsafe. Re-adopt the target
with `skillmux init` before running managed sync again.

Do not delete `.skillmux` markers by hand. The marker gives sync the ownership
record it needs to preserve unrelated content.

## Local overlays

Configure machine-specific override roots:

```toml
vault_path = "~/skills"
local_vault_paths = ["~/skills-local"]
```

Then record the relationship:

```sh
skillmux local-vault init ~/skills-local --yes
skillmux skill which my-skill
```

Read [Configuration](configuration.md#local-vault-overlays) for precedence,
pinning restrictions, and watcher behavior.
