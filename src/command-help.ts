import { SUPPORTED_AGENT_IDS } from "./init-agents";

/** Full per-command help text, keyed by the command names in command-registry.ts. */
export const COMMAND_HELP: Record<string, string> = {
  context: `context: manage named CLI contexts for remote administration

usage:
  skillmux context list
  skillmux context current
  skillmux context add <name> --server <url> [--token-env <env_name>]
  skillmux context use <name>
  skillmux context remove <name>`,

  config: `config: inspect or update server/machine configuration

usage:
  skillmux config init --vault <path> --yes
  skillmux config show [--sources]
  skillmux config get <key>
  skillmux config set <key> <value> [--dry-run]
  skillmux config validate
  skillmux config diff
  skillmux config status

config init bootstraps this machine's config file from a populated vault. It
is not a prerequisite for anything: "skillmux init --vault <path>" runs the
same bootstrap when no config exists, so reach for config init only when you
are setting up the config without the guided init.

Accepts --context <name> / --server <url> to target a remote deployment.`,

  completions: `completions: generate a shell completion script

usage:
  skillmux completions <bash|zsh|fish>`,

  serve: `serve: start the MCP server

usage:
  skillmux serve [--transport stdio|http] [--port <port>] [--stats-port <port>]

--transport defaults to stdio. --stats-port exposes GET /health and GET /stats
alongside a stdio transport without opening the full HTTP surface.`,

  index: `index: rebuild the local retrieval index and backfill embeddings

usage:
  skillmux index`,

  sync: `sync: apply the manifest to the skill directories of this machine's agents

usage:
  skillmux sync [--dry-run] [--no-pull] [--restore-monolith] [--install-hook] [--yes] [--json]

Agents come from "agents" in config.toml; each one's skill directory is fixed
(several agents can share one, e.g. ~/.agents/skills). [core] goes into every
one, and a [project.*] group goes into <path>/<dir> for the directories its own
"agents" read.

With "vault_url" in config.toml, sync first clones the vault into vault_path
or fast-forwards it from that remote, so one command fetches and delivers. A
host with no agents is left alone, and an unreachable remote warns and syncs
the clone already on disk. --no-pull skips the fetch.

--dry-run prints what would change without writing. --yes approves creating
a project skill directory that does not exist yet (its path comes from the
shared vault); without it, an unseen one is skipped rather than created.

--install-hook installs a git post-merge hook in the vault checkout so a
"git pull" re-syncs automatically.

--restore-monolith undoes managed-pin delivery: instead of individual pinned
skills, each agent directory is replaced by a single
symlink to the whole vault. It refuses to touch a directory skillmux does
not own, one carrying a local_vault marker, or one whose marker points at a
different vault.`,

  init: `init: guided setup for native skill management

usage:
  skillmux init [--agent <name>...] [--vault <path>] [--core <skill_id>...]
                [--migrate-full-vault] [--show-mcp-setup] [--register-mcp]
                [--no-instructions] [--no-sync]
                [--interactive|--yes|--dry-run] [--json]

agents: ${SUPPORTED_AGENT_IDS.join(", ")}

Native pins and MCP are independent — skip both of the flags below for
native-only setup, and init writes no instruction files (the managed
block only teaches resolve_skill/fetch_skill, which are MCP tools).
--show-mcp-setup prints the MCP registration snippet to copy in yourself,
for any agent, and also writes the instruction block for every selected
agent. --register-mcp instead runs that agent's own CLI to register
skillmux automatically, but only for claude-code and codex (the only
agents with a verified registration command), and writes the instruction
block just for those; interactively, init asks about this only when
you've selected one of those two. --no-instructions forces instruction
writes off even when an MCP flag is set. A tool not in the agents list
above isn't supported yet. Add it to SUPPORTED_AGENT_IDS rather than
guessing a directory. Selected agents are written to "agents" in config.toml.`,

  project: `project: manage project-scoped skill pins and sync groups

usage:
  skillmux project init [path] [--name <group>] [--skill <skill_id>...]
                [--agent <name>...] [--register-mcp]
                [--no-sync] [--interactive|--yes|--dry-run] [--json]
  skillmux project list
  skillmux project show <group>
  skillmux project add-path <group> [path] --yes
  skillmux project remove-path <group> [path] --yes
  skillmux project pin <group> <skill_id>... --yes
  skillmux project unpin <group> <skill_id>... --yes
  skillmux project attach <group> --agent <id>... --yes
  skillmux project detach <group> --agent <id>... --yes

A project lists the agents that should see its skills in
[project.<group>].agents, shared through the vault. On each machine the
group's skills land in <path>/<dir> for every configured agent directory
one of those agents reads; a machine without any of them skips the group.

--register-mcp is the project-local counterpart to "skillmux init
--register-mcp": only for claude-code (the only agent whose own CLI has a
project MCP scope — codex's mcp add has no scope flag, so it's always
global). It runs "claude mcp add -s project" for this project directory,
which writes a committed .mcp.json shared with your team, and writes a
project-root CLAUDE.md with the resolve_skill/fetch_skill discovery
paragraph — same reasoning as init: no instruction file is written unless
MCP is actually being registered.`,

  agent: `agent: choose which agents this machine syncs skills to

usage:
  skillmux agent list
  skillmux agent add <agent>... --yes [--no-sync]
  skillmux agent remove <agent>... --yes
  skillmux agent rehome --yes

agents: ${SUPPORTED_AGENT_IDS.join(", ")}

add/remove edit "agents" in config.toml. Each agent's skill directory is
fixed, and agents that read the same directory share it: opencode,
github-copilot, windsurf, goose and hermes all use ~/.agents/skills. remove
leaves files in place. rehome re-points managed links after vault_path moves.`,

  core: `core: pin or unpin core-tier skills

usage:
  skillmux core pin <skill_id>... --yes [--no-sync]
  skillmux core unpin <skill_id>... --yes [--no-sync]

Pinning writes the manifest and then syncs, so the change reaches every agent
directory in one command. --no-sync writes the manifest alone, for batching
several pins before a single sync. A project directory this machine has never
synced still needs its own approval and is reported as skipped, so a pin never
creates one.`,

  report: `report: show routing/fetch-outcome audit statistics

usage:
  skillmux report [--context <name> | --server <url> | --db <path>] --since <window> [--json]`,

  audit: `audit: prune the audit database

usage:
  skillmux audit prune [--older-than <window>] [--dry-run] [--yes] [--json]

Accepts --context <name> / --server <url> to prune a remote deployment's audit db.`,

  scan: `scan: check the vault for install-time or integrity issues

usage:
  skillmux scan [path] [--fail-on low|medium|high|none] [--json]

Scans [path], or the configured vault when omitted. Reporting only: it
exits 0 whatever it finds unless --fail-on names a severity, which is why
it has no default threshold while install and update default to high.

--format text|json is deprecated: it emits JSON outside the standard
envelope. Use --json instead; --format will be removed in a future 1.x
release.`,

  install: `install: install a skill from a git source

usage:
  skillmux install <repo>[/path] [--yes] [--force] [--fail-on low|medium|high|none] [--dry-run] [--allow-local-source] [--json]

--yes approves writing the skill into the vault. Without it an interactive
run asks first, and a non-interactive one (no TTY, or --json) fails rather
than installing unattended, matching "skillmux update".

The fetched skill is scanned before it is written to the vault. --fail-on
sets the severity that aborts the install and defaults to high; pass
--fail-on none to install despite findings. A lower threshold is stricter:
low aborts on low, medium and high.

--force overwrites a skill that already exists in the vault instead of
refusing. --dry-run reports where the skill would land without writing.
--allow-local-source permits a file:// or local path source, which is
otherwise rejected.`,

  outdated: `outdated: list installed skills with a newer upstream version

usage:
  skillmux outdated [--allow-local-source] [--json]

Read-only: it reports what "skillmux update" would change and writes
nothing. --allow-local-source includes skills installed from a local or
file:// source, which are skipped by default because their upstream is a
path on this machine rather than a shared remote.`,

  update: `update: update one or all skills to their latest source version

usage:
  skillmux update [skill-id] [--yes] [--dry-run] [--force] [--allow-local-source] [--fail-on low|medium|high|none] [--json]

Updates every installed skill, or just <skill-id>. --yes is required to
apply non-interactively. --dry-run prints the plan without writing.

--fail-on works exactly as it does for install and defaults to high, so a
skill whose new version carries a high-severity finding is skipped rather
than updated; --fail-on none restores the old permissive behavior.

--force updates a skill whose local content no longer matches the hash
recorded at install time, which otherwise blocks the update to avoid
discarding local edits. --allow-local-source permits local/file:// sources.`,

  eval: `eval: run retrieval evaluation against the holdout set

usage:
  skillmux eval [--json]
  skillmux eval promote --since <window> [--out <path>] [--dry-run] [--yes] [--json]

Accepts --context <name> / --server <url> to evaluate a remote deployment.`,

  doctor: `doctor: check server/environment readiness

usage:
  skillmux doctor [--verbose] [--json]

Failing checks print first, and a final line tallies the result. The per-key
config source checks collapse into one count by source (environment, toml,
default); --verbose lists each key. --json always carries every check.

Accepts --context <name> / --server <url> to check a remote deployment.`,

  skill: `skill: inspect local vault skill resolution

usage:
  skillmux skill which <skill_id>  (local vault shadow resolution; unrelated to MCP routing)`,

  "local-vault": `local-vault: register an additional local vault checkout

usage:
  skillmux local-vault init <path> --yes`,

  models: `models: manage local embedding model downloads

usage:
  skillmux models download`,
};
