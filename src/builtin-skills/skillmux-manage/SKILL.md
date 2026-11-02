---
name: skillmux-manage
description: Manage skillmux itself. Use when the user asks which skills they have, wants a skill made core or project-scoped, wants skills installed from a Git repository, or asks about skillmux status, sync, or updates.
skillmux_version: "{{version}}"
---

# Managing skillmux

This skill matches skillmux {{version}}. If `skillmux --version` prints a different version, run `skillmux --help --json` and trust its output over this text.

## Ground rules

1. Pass `--json` to every command and read the `data` field of the result. A failure has `ok: false` and an `error.code`; `USAGE_ERROR` means the arguments were wrong, and `error.message` shows the usage.
2. Before any command that writes, run it once with `--dry-run` and show the user what would change.
3. Pass `--yes` only after the user has confirmed that change. Never add it on your own to get past a prompt.
4. Do not edit `skillmux.toml`, `config.toml`, or agent skill directories by hand. The commands below keep them consistent.
5. To learn which commands exist and which ones write, run `skillmux --help --json`. Each command lists its flags, its subcommands, and `writes` or `writing_subcommands`.

## Look before you change anything

- `skillmux status --json` shows the vault, core usage against its limit, each agent's skill directory, and any problem that needs fixing.
- `skillmux skill list --json` lists every skill with its description and placement. The placement is `core` (every agent sees it), `project` (only the groups in `project_groups`), or `mcp-only` (found through `resolve_skill` and `fetch_skill`).
- `skillmux skill list --placement core --json` filters to one placement.
- `skillmux skill which <skill_id> --json` shows which vault root serves a skill and which roots it shadows.
- `skillmux project list --json` and `skillmux agent list --json` show project groups and configured agents.
- `skillmux doctor --json` runs the deeper health checks.

## Common tasks

Make a skill core. Core skills load into every session, so each one costs context. Check `status` first: `core.count` must stay below `core.limit`.

```sh
skillmux core pin <skill_id> --dry-run --json
skillmux core pin <skill_id> --yes --json
```

Remove a skill from core with `skillmux core unpin <skill_id>`. It goes back to `mcp-only` and stays reachable through `resolve_skill`.

Scope a skill to one project instead of every session:

```sh
skillmux project list --json
skillmux project pin <group> <skill_id> --dry-run --json
skillmux project pin <group> <skill_id> --yes --json
```

Set up a new project group with `skillmux project init <path>`.

Install skills from a Git repository. `<repo>` is `owner/repo/path` or a Git URL. Installs run a content scan, and a skill that fails it is skipped, so report any skipped skill to the user.

```sh
skillmux install <repo> --dry-run --json
skillmux install <repo> --yes --json
```

Sync pinned skills into the agents' directories. Pin commands already sync unless `--no-sync` was passed, so run this after batching pins or after a vault update:

```sh
skillmux sync --dry-run
skillmux sync --yes
```

Check for upstream changes to installed skills, then update:

```sh
skillmux outdated --json
skillmux update <skill_id> --dry-run --json
skillmux update <skill_id> --yes --json
```

Add an agent to this machine with `skillmux agent add <agent> --yes`.

## When something looks wrong

- A skill is missing from `skill list`: look at `data.invalid` in the same result. It names skills whose `SKILL.md` could not be read, with the reason.
- A skill is missing from an agent: run `skillmux status --json` and look for an agent directory whose `state` is not `managed`, then run `skillmux sync`.
- `REMOTE_CONTEXT_UNSUPPORTED`: the command only works on the machine that owns the agent directories. Drop `--context` and `--server`, or pass `--context local`.
- After a skillmux upgrade, run `skillmux init --manage-skill --yes` to refresh this skill.
