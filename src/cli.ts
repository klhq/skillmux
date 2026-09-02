#!/usr/bin/env bun
import packageJson from "../package.json" with { type: "json" };
import { lstatSync, mkdirSync } from "node:fs";

import { createClients } from "./clients";
import { loadConfig } from "./config";
import { openAudit } from "./db";
import { getEffectiveConfig } from "./config-service";
import { buildRedactor } from "./redact";
import { evalVault } from "./eval";
import { runOutdated } from "./commands/outdated";
import { runUpdate } from "./commands/update";
import { serializeManifest } from "./manifest";

import { backfillEmbeddings, configure, rebuildIndex } from "./router-core";
import { type StatsResponse } from "./stats";
import { scanVault } from "./vault";

import { resolveContext, type ResolvedContext } from "./context";
import { createTargetAdapter, isLoopbackHost, type TargetAdapter } from "./adapters";
import {
  emitSuccess,
  CliError,
  formatJsonEnvelope,
  mapExitCode,
  red,
  suggestCorrection,
  warn,
} from "./output";
import { generateCompletions, type ShellType } from "./completions";
import { SUPPORTED_AGENT_IDS } from "./init-agents";
import { runAudit } from "./commands/audit";
import { handleConfigCommand } from "./commands/config";
import { handleContextCommand } from "./commands/context";
import { runDoctor } from "./commands/doctor";
import { runEvalPromote } from "./commands/eval";
import { runInstall } from "./commands/install";
import { runCore } from "./commands/core";
import { runLocalVaultInit } from "./commands/local-vault";
import { runModelDownload } from "./commands/models";
import { runProject } from "./commands/project";
import { runReport } from "./commands/report";
import { runScan } from "./commands/scan";
import { runSkill } from "./commands/skill";
import { runTarget } from "./commands/target";
import { runSync } from "./commands/sync";
import { runInit } from "./commands/init";

export const KNOWN_COMMANDS = [
  "context",
  "config",
  "completions",
  "serve",
  "index",
  "sync",
  "init",
  "project",
  "target",
  "core",
  "report",
  "audit",
  "scan",
  "install",
  "outdated",
  "update",
  "eval",
  "doctor",
  "models",
  "skill",
  "local-vault",
];

/**
 * Declared target support for every command in KNOWN_COMMANDS — the single
 * source of truth getLocalOnlyCommand() enforces against. A command missing
 * from here, or misclassified, is a bug: see tests/cli-target-support.test.ts,
 * which fails the build rather than letting a command silently drift out of
 * sync the way `config init` did (it was never rejected for a remote target,
 * nor actually remote-capable — it just silently ran local logic that choked
 * on an unrecognized --context/--server flag with a confusing error).
 *
 * - "local-only": operates on this machine's vault/filesystem/agents only;
 *   a remote target is rejected outright.
 * - "remote-capable": routed through TargetAdapter — same command, backed by
 *   LocalAdapter or RemoteAdapter depending on the resolved target.
 * - "target-agnostic": the resolved target isn't used to decide behavior at
 *   all (context management is inherently local; completions never touch
 *   vault/server state).
 *
 * Subcommand-level exceptions within an otherwise-classified command (e.g.
 * `config init`, which bootstraps *this machine's* config file and so is
 * local-only despite `config` overall being remote-capable) are handled in
 * getLocalOnlyCommand() itself, not in this top-level map.
 */
export type CommandTargetSupport = "local-only" | "remote-capable" | "target-agnostic";

export const COMMAND_TARGET_SUPPORT: Record<string, CommandTargetSupport> = {
  context: "target-agnostic",
  config: "remote-capable",
  completions: "target-agnostic",
  serve: "local-only",
  index: "local-only",
  sync: "local-only",
  init: "local-only",
  project: "local-only",
  target: "local-only",
  core: "local-only",
  report: "remote-capable",
  audit: "remote-capable",
  scan: "local-only",
  install: "local-only",
  outdated: "local-only",
  update: "local-only",
  eval: "remote-capable",
  doctor: "remote-capable",
  models: "local-only",
  skill: "local-only",
  "local-vault": "local-only",
};

const LOCAL_ONLY_COMMANDS = new Set(
  Object.entries(COMMAND_TARGET_SUPPORT)
    .filter(([, support]) => support === "local-only")
    .map(([command]) => command),
);

export function getLocalOnlyCommand(command: string, subCommand: string): string | null {
  if (command === "skill" && (subCommand === "which" || !subCommand)) {
    return "skill which";
  }
  if (command === "config" && subCommand === "init") {
    return "config init";
  }
  if (LOCAL_ONLY_COMMANDS.has(command)) {
    return command;
  }
  return null;
}

/**
 * Why a local-only command can't take a remote target, keyed by the exact
 * string getLocalOnlyCommand() returns. Drives the guidance sentence
 * remoteContextUnsupported() appends, so the rejection points somewhere
 * useful instead of just saying no.
 */
type LocalOnlyReason = "vault-content" | "native-delivery" | "local-runtime" | "local-config";

const LOCAL_ONLY_REASON: Record<string, LocalOnlyReason> = {
  install: "vault-content",
  update: "vault-content",
  outdated: "vault-content",
  scan: "vault-content",
  init: "native-delivery",
  sync: "native-delivery",
  target: "native-delivery",
  core: "native-delivery",
  project: "native-delivery",
  "local-vault": "native-delivery",
  "skill which": "native-delivery",
  serve: "local-runtime",
  models: "local-runtime",
  index: "local-runtime",
  "config init": "local-config",
};

const LOCAL_ONLY_GUIDANCE: Record<LocalOnlyReason, string> = {
  "vault-content":
    "To change a remote deployment's vault contents, update its git-backed source and redeploy or pull on that host — skillmux doesn't replicate vault checkouts over the network.",
  "native-delivery":
    "This manages skill delivery into agent directories on the machine you run it from; there's no remote equivalent — run it on the machine that owns those directories.",
  "local-runtime":
    "This operates on the local runtime process on the machine you run it from.",
  "local-config":
    "This bootstraps this machine's own config file. To inspect or change a remote deployment's configuration, use \"skillmux config show/set --context <name>\" instead.",
};

function remoteContextUnsupported(rejectedCommand: string): CliError {
  const reason = LOCAL_ONLY_REASON[rejectedCommand];
  const guidance = reason ? ` ${LOCAL_ONLY_GUIDANCE[reason]}` : "";
  return new CliError(
    `\`${rejectedCommand}\` operates on the local vault only; --context/--server isn't supported here.${guidance}`,
    2,
    "REMOTE_CONTEXT_UNSUPPORTED",
    {
      rejected_command: rejectedCommand,
      ...(reason ? { reason } : {}),
    },
  );
}

function isDockerHostManagementCommand(command: string, subCommand: string): boolean {
  if (
    [
      "init",
      "sync",
      "install",
      "outdated",
      "update",
      "project",
      "target",
      "core",
      "local-vault",
      "models",
      "context",
    ].includes(command)
  ) {
    return true;
  }

  // eval promote only touches the mounted state_dir, unlike bare `eval`
  // (vault ranking evaluation), which needs an embeddings client and the vault.
  if (command === "eval" && subCommand !== "promote") return true;

  return command === "config" && ["init", "set"].includes(subCommand);
}

function containerCommandUnsupported(command: string, subCommand: string): CliError {
  const rejectedCommand = [command, subCommand].filter(Boolean).join(" ");
  const recommendedHostCommand = `skillmux ${rejectedCommand}`;
  const guide = "docs/deployment.md";
  const documentation =
    "https://github.com/klhq/skillmux/blob/main/docs/deployment.md#container-command-contract";
  return new CliError(
    `\`skillmux ${rejectedCommand}\` manages host agent directories and cannot run in the Skillmux server image.\n\n` +
      "Install the host CLI:\n" +
      "  bun add -g @klhapp/skillmux\n\n" +
      "Then run:\n" +
      `  ${recommendedHostCommand}\n\n` +
      `See ${guide} for server deployment examples.`,
    2,
    "CONTAINER_COMMAND_UNSUPPORTED",
    {
      // `command` remains for automation written against the first Docker
      // boundary release. `rejected_command` is the explicit contract name.
      command: rejectedCommand,
      rejected_command: rejectedCommand,
      recommended_host_command: recommendedHostCommand,
      guide,
      documentation,
    },
  );
}

async function main() {
  const rawArgv = Bun.argv.slice(2);

  let isJson = process.env.SKILLMUX_JSON === "true";
  let allowInsecure = false;
  let isVerbose = false;
  let flagContext: string | undefined;
  let flagServer: string | undefined;
  let isDryRun = false;
  // Global flags do not form part of the command identity reported to users.
  // In particular, `init --json` should recommend `skillmux init`, not a
  // redundant JSON-only host command.
  const subCommand = rawArgv[1]?.startsWith("-") ? "" : rawArgv[1] ?? "";
  const commandArgs = rawArgv.slice(2);

  const command = rawArgv[0];
  if (command === "--version" || command === "-V") {
    console.log(packageJson.version);
    return;
  }

  if (!command || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  // Parse global flags for context/config
  for (let i = 0; i < rawArgv.length; i++) {
    const arg = rawArgv[i];
    if (arg === "--json") isJson = true;
    else if (arg === "--allow-insecure") allowInsecure = true;
    else if (arg === "--verbose") isVerbose = true;
    else if (arg === "--dry-run") isDryRun = true;
    else if (arg === "--context") flagContext = rawArgv[++i];
    else if (arg === "--server") flagServer = rawArgv[++i];
  }

  let resolvedTarget: ResolvedContext = { type: "local", name: "local" };

  if (
    process.env.RUNNING_IN_DOCKER === "true" &&
    isDockerHostManagementCommand(command, subCommand)
  ) {
    await handleError(containerCommandUnsupported(command, subCommand), {
      target: resolvedTarget,
      isJson,
      isVerbose,
    });
    return;
  }

  if (
    (rawArgv.includes("--help") || rawArgv.includes("-h")) &&
    printCommandHelp(command)
  ) {
    return;
  }

  try {
    resolvedTarget = await resolveContext({
      context: flagContext,
      server: flagServer,
    });
  } catch (err: any) {
    await handleError(err, { target: resolvedTarget, isJson, isVerbose });
    return;
  }

  const localOnlyCommand = getLocalOnlyCommand(command, subCommand);
  if (localOnlyCommand && resolvedTarget.type === "remote") {
    await handleError(remoteContextUnsupported(localOnlyCommand), {
      target: resolvedTarget,
      isJson,
      isVerbose,
    });
    return;
  }

  const adapter = createTargetAdapter(resolvedTarget, { allowInsecure });

  try {
    switch (command) {
      case "context":
        await handleContextCommand(subCommand, commandArgs, {
          target: resolvedTarget,
          isJson,
        });
        break;
      case "config":
        await handleConfigCommand(adapter, subCommand, commandArgs, {
          target: resolvedTarget,
          isJson,
          dryRun: isDryRun,
        });
        break;
      case "calibrate":
        throw new Error(
          'skillmux calibrate was removed. Threshold calibration was removed; use "skillmux eval" for ranking evaluation.',
        );
      case "completions":
        await handleCompletionsCommand(subCommand);
        break;
      case "serve": {
        const { startServer } = await import("./server");
        const { transport, port, statsPort } = parseServeArgs(rawArgv.slice(1));
        const handle = await startServer({ transport, port, statsPort });
        let stopping = false;
        const shutdown = async () => {
          if (stopping) return;
          stopping = true;
          const timeout = setTimeout(() => process.exit(1), 10_000);
          timeout.unref();
          await handle.stop();
          clearTimeout(timeout);
          process.exit(0);
        };
        process.once("SIGTERM", shutdown);
        process.once("SIGINT", shutdown);
        if (transport === "stdio") {
          process.stdin.on("close", shutdown);
          process.stdin.on("end", shutdown);
        }
        break;
      }
      case "index":
        await runIndex();
        break;
      case "sync":
        await runSync(rawArgv.slice(1));
        break;
      case "init":
        await runInit(rawArgv.slice(1), { isJson, dryRun: isDryRun });
        break;
      case "project":
        await runProject(subCommand, commandArgs, {
          isJson,
          dryRun: isDryRun,
          sync: runSync,
        });
        break;
      case "target":
        await runTarget(subCommand, commandArgs, { isJson, dryRun: isDryRun });
        break;
      case "core":
        await runCore(subCommand, commandArgs, { isJson, dryRun: isDryRun });
        break;
      case "report":
        await runReport(rawArgv.slice(1), {
          isJson,
          target: resolvedTarget,
          allowInsecure,
          adapter,
        });
        break;
      case "audit":
        await runAudit(subCommand, commandArgs, {
          isJson,
          dryRun: isDryRun,
          target: resolvedTarget,
          adapter,
        });
        break;
      case "scan":
        await runScan(rawArgv.slice(1), { isJson });
        break;
      case "install":
        await runInstall(rawArgv.slice(1), { isJson });
        break;
      case "outdated":
        await runOutdated(rawArgv.slice(1), { isJson });
        break;
      case "update":
        await runUpdate(rawArgv.slice(1), { isJson });
        break;
      case "eval":
        if (subCommand === "promote") {
          await runEvalPromote(commandArgs, { isJson, dryRun: isDryRun, adapter });
        } else if (subCommand === "") {
          await runEval({ isJson, adapter });
        } else {
          throw new Error(`usage: skillmux eval [promote --since <window> [--target <path>] [--dry-run] [--yes] [--json]]`);
        }
        break;
      case "doctor":
        await runDoctor({
          isJson,
          target: resolvedTarget,
          adapter,
          args: rawArgv.slice(1),
        });
        break;
      case "which":
        throw new Error(
          `skillmux which is removed - use "skillmux skill which ${subCommand || "<skill_id>"}" instead`,
        );
      case "skill":
        await runSkill(subCommand, commandArgs);
        break;
      case "manifest":
        throw new Error(
          `skillmux manifest is removed - use "skillmux core ${subCommand || "pin|unpin"}" for [core] skills, or "skillmux project ${subCommand || "pin|unpin"} <group>" for [project.*] skills`,
        );
      case "local-vault":
        if (subCommand !== "init")
          throw new Error("usage: skillmux local-vault init <path>");
        await runLocalVaultInit(commandArgs, { isJson, dryRun: isDryRun });
        break;
      case "models":
        if (subCommand !== "download")
          throw new Error("usage: skillmux models download");
        await runModelDownload({ isJson });
        break;
      default: {
        const suggestion = suggestCorrection(command, KNOWN_COMMANDS);
        const msg = suggestion
          ? `Unknown command "${command}". Did you mean "${suggestion}"?`
          : `usage: skillmux <serve|index|sync|init|project|target|core pin/unpin|report|audit prune|scan|install|outdated|update|eval|doctor|skill which|local-vault init|config show|models download>`;
        throw new Error(msg);
      }
    }
  } catch (err: any) {
    await handleError(err, { target: resolvedTarget, isJson, isVerbose });
  }
}



async function handleCompletionsCommand(shell: string) {
  if (shell !== "bash" && shell !== "zsh" && shell !== "fish") {
    throw new Error("usage: skillmux completions <bash|zsh|fish>");
  }
  console.log(generateCompletions(shell as ShellType));
}

async function handleError(
  err: any,
  opts: { target: ResolvedContext; isJson: boolean; isVerbose: boolean },
) {
  const code = mapExitCode(err);
  process.exitCode = code;

  const rawMsg = err instanceof Error ? err.message : String(err);
  // Best-effort: a broken config must not suppress the original error report,
  // so fall back to the URL-credential-only layer of buildRedactor(undefined)
  // rather than let a config-load failure mask the real failure.
  let redact: (text: string) => string;
  try {
    const { effective } = await getEffectiveConfig();
    redact = buildRedactor(effective);
  } catch {
    redact = buildRedactor(undefined);
  }
  const msg = redact(rawMsg);

  if (opts.isJson) {
    const env = formatJsonEnvelope({
      ok: false,
      target: opts.target,
      error: {
        code: err instanceof CliError ? err.code : `EXIT_${code}`,
        message: msg,
        details: err instanceof CliError ? err.details : undefined,
      },
    });
    console.log(JSON.stringify(env));
  } else {
    console.error(
      red(
        msg.startsWith("usage:") ||
          msg.startsWith("Unknown") ||
          msg.startsWith("error:")
          ? msg
          : `error: ${msg}`,
      ),
    );
    if (opts.isVerbose && err instanceof Error && err.stack) {
      console.error(redact(err.stack));
    }
  }
}

const COMMAND_HELP: Record<string, string> = {
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

  sync: `sync: apply the manifest to native agent target directories

usage:
  skillmux sync [--dry-run] [--restore-monolith] [--install-hook] [--yes] [--json]`,

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
above isn't supported by init yet — add it to SUPPORTED_AGENT_IDS rather
than guessing a directory. To adopt an arbitrary existing directory
directly, use "skillmux target add <name> --dir <dir>" instead of init.`,

  project: `project: manage project-scoped skill pins and sync groups

usage:
  skillmux project init [path] [--name <group>] [--skill <skill_id>...]
                [--agent <name>...] [--target <name>...] [--register-mcp]
                [--no-sync] [--interactive|--yes|--dry-run] [--json]
  skillmux project list
  skillmux project show <group>
  skillmux project add-path <group> [path] --yes
  skillmux project remove-path <group> [path] --yes
  skillmux project pin <group> <skill_id>... --yes
  skillmux project unpin <group> <skill_id>... --yes
  skillmux project attach <group> (--agent <id>... | --target <name>...) --yes
  skillmux project detach <group> (--agent <id>... | --target <name>...) --yes

--register-mcp is the project-local counterpart to "skillmux init
--register-mcp": only for claude-code (the only agent whose own CLI has a
project MCP scope — codex's mcp add has no scope flag, so it's always
global). It runs "claude mcp add -s project" for this project directory,
which writes a committed .mcp.json shared with your team, and writes a
project-root CLAUDE.md with the resolve_skill/fetch_skill discovery
paragraph — same reasoning as init: no instruction file is written unless
MCP is actually being registered.`,

  target: `target: manage native sync target directories

usage:
  skillmux target list
  skillmux target show <name>
  skillmux target add <name> [--dir <dir>] --yes
  skillmux target remove <name> --yes

--dir may be omitted when <name> is a built-in target with a deterministic
path: agent-skills, claude-code, codex. Any other <name> requires --dir.`,

  core: `core: pin or unpin core-tier skills

usage:
  skillmux core pin <skill_id>... --yes
  skillmux core unpin <skill_id>... --yes`,

  report: `report: show routing/fetch-outcome audit statistics

usage:
  skillmux report [--context <name> | --server <url> | --db <path>] --since <window> [--json]`,

  audit: `audit: prune the audit database

usage:
  skillmux audit prune [--older-than <window>] [--dry-run] [--yes] [--json]

Accepts --context <name> / --server <url> to prune a remote deployment's audit db.`,

  scan: `scan: check the vault for install-time or integrity issues

usage:
  skillmux scan [path] [--format text|json] [--fail-on low|medium|high] [--json]`,

  install: `install: install a skill from a git source

usage:
  skillmux install <repo>[/path] [--force] [--fail-on low|medium|high] [--dry-run] [--allow-local-source] [--json]`,

  outdated: `outdated: list installed skills with a newer upstream version

usage:
  skillmux outdated [--allow-local-source] [--json]`,

  update: `update: update one or all skills to their latest source version

usage:
  skillmux update [skill-id] [--yes] [--dry-run] [--force] [--allow-local-source] [--fail-on low|medium|high] [--json]`,

  eval: `eval: run retrieval evaluation against the holdout set

usage:
  skillmux eval [--json]
  skillmux eval promote --since <window> [--target <path>] [--dry-run] [--yes] [--json]

Accepts --context <name> / --server <url> to evaluate a remote deployment.`,

  doctor: `doctor: check server/environment readiness

usage:
  skillmux doctor [--json]

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

function printCommandHelp(command: string): boolean {
  const help = COMMAND_HELP[command];
  if (!help) return false;
  console.log(help);
  return true;
}

function printHelp(): void {
  if (process.env.RUNNING_IN_DOCKER === "true") {
    console.log(`Skillmux server image

Default:
  serve --transport http

Supported commands:
  serve, index, doctor, report, audit prune, eval promote, scan, skill which
  config show|get|validate|diff|status

Native skill management:
  Install the Skillmux CLI on the host for init, install, pinning, and sync.

See docs/deployment.md for server deployment examples.`);
    return;
  }

  console.log(`usage: skillmux <command> [options]

Setup:
  skillmux config init --vault <path> --yes
  skillmux init [--agent <name>...] [--vault <path>] [--core <skill_id>...]
                [--migrate-full-vault] [--no-instructions] [--no-sync]
                [--interactive|--yes|--dry-run] [--json]
  skillmux project init [path] [--name <group>] [--skill <skill_id>...]
                [--agent <name>...] [--target <name>...] [--no-sync]
                [--interactive|--yes|--dry-run] [--json]
  skillmux project <list|show|add-path|remove-path|pin|unpin|attach|detach>
  skillmux target <list|show|add|remove>
  skillmux core <pin|unpin> <skill_id>... [--yes] [--dry-run] [--json]
  skillmux skill which <skill_id>  (local vault shadow resolution; unrelated to MCP routing)

Init agents:
  ${SUPPORTED_AGENT_IDS.join(", ")}
  ("skillmux init --show-mcp-setup" also prints the MCP registration
  snippet, independent of which agents you select. A tool not in this
  list isn't supported by init yet — see "skillmux init --help".)

Operations:
  skillmux report [--context <name> | --server <url> | --db <path>] --since <window> [--json]
  skillmux audit prune [--older-than <window>] [--dry-run] [--yes] [--json]
  skillmux eval promote --since <window> [--target <path>] [--dry-run] [--yes] [--json]
  skillmux outdated [--allow-local-source] [--json]
  skillmux update [skill-id] [--yes] [--dry-run] [--force] [--allow-local-source] [--fail-on low|medium|high] [--json]

Commands:
  serve, index, sync, init, project, target, core, report, audit, scan, install, outdated, update,
  eval, doctor, skill, local-vault, config, models, context, completions

Run "skillmux <command> --help" for a command's full usage.`);
}

// ---------------------------------------------------------------------------
// Implementation of commands: serve, index, sync, init, report, scan, install, eval, doctor, models
// ---------------------------------------------------------------------------

type Transport = "stdio" | "http";

function parseServeArgs(args: string[]): {
  transport: Transport;
  port?: number;
  statsPort?: number;
} {
  let transport: Transport = "stdio";
  let port: number | undefined;
  let statsPort: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const option = args[i];
    const value = args[i + 1];
    if (option === "--transport") {
      if (value !== "stdio" && value !== "http") {
        throw new Error("--transport must be stdio or http");
      }
      transport = value;
      i++;
    } else if (option === "--port") {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) {
        throw new Error("--port must be an integer between 0 and 65535");
      }
      port = parsed;
      i++;
    } else if (option === "--stats-port") {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) {
        throw new Error("--stats-port must be an integer between 0 and 65535");
      }
      statsPort = parsed;
      i++;
    } else {
      throw new Error(`unknown serve option: ${option}`);
    }
  }
  return { transport, port, statsPort };
}

async function runIndex(): Promise<void> {
  const config = await loadConfig();
  configure({ config, clients: createClients(config) });
  const report = await rebuildIndex((skillId, error) => {
    warn(`keeping previous index entry for ${skillId}: ${error}`);
  });
  const retainedNote =
    report.retained.length > 0
      ? ` (${report.retained.length} retained after parse errors)`
      : "";
  console.log(`indexed ${report.indexed} skills${retainedNote}`);

  try {
    const backfilled = await backfillEmbeddings();
    console.log(`embeddings: ${backfilled} backfilled`);
  } catch {
    console.log(
      "embeddings: skipped (endpoint unreachable; lexical-only recall until next index)",
    );
  }
}

async function runEval(options: { isJson: boolean; adapter: TargetAdapter }): Promise<void> {
  const config = await loadConfig();
  configure({ config, clients: createClients(config) });

  const report = await options.adapter.evalRun().catch((error: unknown) => {
    throw new Error(
      `eval requires an embeddings client (local model or a configured remote endpoint): ${String(error)}`,
    );
  });
  emitSuccess({ isJson: options.isJson }, report, () => {
    console.log(`holdout queries:   ${report.queries}`);
    console.log(`judged queries:    ${report.judged_queries}`);
    console.log(`unjudged queries:  ${report.unjudged_queries}`);
    console.log(`lexical recall@5:  ${report.lexical.recall_at_5.toFixed(3)}`);
    console.log(`lexical recall@10: ${report.lexical.recall_at_10.toFixed(3)}`);
    console.log(`lexical MRR:       ${report.lexical.mrr.toFixed(3)}`);
    console.log(`lexical nDCG@10:   ${report.lexical.ndcg_at_10.toFixed(3)}`);
    console.log(`hybrid recall@5:   ${report.hybrid.recall_at_5.toFixed(3)}`);
    console.log(`hybrid recall@10:  ${report.hybrid.recall_at_10.toFixed(3)}`);
    console.log(`hybrid MRR:        ${report.hybrid.mrr.toFixed(3)}`);
    console.log(`hybrid nDCG@10:    ${report.hybrid.ndcg_at_10.toFixed(3)}`);
  });
}


if (import.meta.main) {
  await main();
}
