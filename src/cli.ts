#!/usr/bin/env bun
import { unknownOptionError, usageError } from "./arg-errors";
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
import { createContextAdapter, isLoopbackHost, type ContextAdapter } from "./adapters";
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
import { COMMAND_HELP } from "./command-help";
import {
  COMMANDS,
  KNOWN_COMMANDS,
  findCommand,
  isDockerHostOnly,
  type CommandContextSupport,
  type LocalOnlyReason,
} from "./command-registry";
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
import { runAgent } from "./commands/agent";
import { runSync } from "./commands/sync";
import { runInit } from "./commands/init";

export { KNOWN_COMMANDS };

/**
 * Declared context support for every command in the registry: the single
 * source of truth getLocalOnlyCommand() enforces against. See
 * CommandContextSupport in command-registry.ts for the three classifications,
 * and tests/cli-context-support.test.ts, which fails the build if a command
 * drifts out of sync.
 *
 * Subcommand-level exceptions within an otherwise-classified command (e.g.
 * `config init`, which bootstraps *this machine's* config file and so is
 * local-only despite `config` overall being remote-capable) come from
 * `localOnlySubcommands` in the registry.
 */
export type { CommandContextSupport };

export const COMMAND_CONTEXT_SUPPORT: Record<string, CommandContextSupport> =
  Object.fromEntries(COMMANDS.map((c) => [c.name, c.contextSupport]));

export function getLocalOnlyCommand(command: string, subCommand: string): string | null {
  const spec = findCommand(command);
  if (!spec) return null;
  if (spec.contextSupport === "local-only") {
    // `skill` takes only `which`, so a bare `skill` is rejected under that name too.
    return spec.localOnlyLabel ?? command;
  }
  if (subCommand && spec.localOnlySubcommands?.[subCommand]) {
    return `${command} ${subCommand}`;
  }
  return null;
}

/**
 * Why a local-only command can't take a remote context, keyed by the exact
 * string getLocalOnlyCommand() returns. Drives the guidance sentence
 * remoteContextUnsupported() appends, so the rejection points somewhere
 * useful instead of just saying no.
 */
const LOCAL_ONLY_REASON: Record<string, LocalOnlyReason> = Object.fromEntries(
  COMMANDS.flatMap((c): [string, LocalOnlyReason][] => [
    ...(c.localOnlyReason ? [[c.localOnlyLabel ?? c.name, c.localOnlyReason] as [string, LocalOnlyReason]] : []),
    ...Object.entries(c.localOnlySubcommands ?? {}).map(
      ([sub, reason]) => [`${c.name} ${sub}`, reason] as [string, LocalOnlyReason],
    ),
  ]),
);

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

  let resolvedContext: ResolvedContext = { type: "local", name: "local" };

  if (
    process.env.RUNNING_IN_DOCKER === "true" &&
    isDockerHostOnly(command, subCommand)
  ) {
    await handleError(containerCommandUnsupported(command, subCommand), {
      context: resolvedContext,
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
    resolvedContext = await resolveContext({
      context: flagContext,
      server: flagServer,
    });
  } catch (err: any) {
    await handleError(err, { context: resolvedContext, isJson, isVerbose });
    return;
  }

  const localOnlyCommand = getLocalOnlyCommand(command, subCommand);
  if (localOnlyCommand && resolvedContext.type === "remote") {
    await handleError(remoteContextUnsupported(localOnlyCommand), {
      context: resolvedContext,
      isJson,
      isVerbose,
    });
    return;
  }

  const adapter = createContextAdapter(resolvedContext, { allowInsecure });

  try {
    switch (command) {
      case "context":
        await handleContextCommand(subCommand, commandArgs, {
          context: resolvedContext,
          isJson,
        });
        break;
      case "config":
        await handleConfigCommand(adapter, subCommand, commandArgs, {
          context: resolvedContext,
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
      case "agent":
        await runAgent(subCommand, commandArgs, { isJson, dryRun: isDryRun });
        break;
      case "core":
        await runCore(subCommand, commandArgs, { isJson, dryRun: isDryRun });
        break;
      case "report":
        await runReport(rawArgv.slice(1), {
          isJson,
          context: resolvedContext,
          allowInsecure,
          adapter,
        });
        break;
      case "audit":
        await runAudit(subCommand, commandArgs, {
          isJson,
          dryRun: isDryRun,
          context: resolvedContext,
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
          throw usageError(`unknown eval subcommand "${subCommand}"`, "usage: skillmux eval [promote --since <window> [--out <path>] [--dry-run] [--yes] [--json]]");
        }
        break;
      case "doctor":
        await runDoctor({
          isJson,
          context: resolvedContext,
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
          throw usageError(
            subCommand ? `unknown local-vault subcommand "${subCommand}"` : "missing subcommand",
            "usage: skillmux local-vault init <path>",
          );
        await runLocalVaultInit(commandArgs, { isJson, dryRun: isDryRun });
        break;
      case "models":
        if (subCommand !== "download")
          throw usageError(
            subCommand ? `unknown models subcommand "${subCommand}"` : "missing subcommand",
            "usage: skillmux models download",
          );
        await runModelDownload({ isJson });
        break;
      case "target":
        throw new Error(
          '"skillmux target" was replaced by "skillmux agent": list agents in config.toml ' +
            '(agents = [...]) instead of naming directories. See "skillmux agent --help"',
        );
      default: {
        const suggestion = suggestCorrection(command, KNOWN_COMMANDS);
        const msg = suggestion
          ? `Unknown command "${command}". Did you mean "${suggestion}"?`
          : `Unknown command "${command}". Run "skillmux --help" to see the available commands: ${KNOWN_COMMANDS.join(", ")}.`;
        throw new Error(msg);
      }
    }
  } catch (err: any) {
    await handleError(err, { context: resolvedContext, isJson, isVerbose });
  }
}



async function handleCompletionsCommand(shell: string) {
  if (shell !== "bash" && shell !== "zsh" && shell !== "fish") {
    throw usageError(shell ? `unsupported shell "${shell}"` : "missing <shell> argument", "usage: skillmux completions <bash|zsh|fish>");
  }
  console.log(generateCompletions(shell as ShellType));
}

async function handleError(
  err: any,
  opts: { context: ResolvedContext; isJson: boolean; isVerbose: boolean },
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
      context: opts.context,
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
  skillmux init [--agent <name>...] [--vault <path>] [--core <skill_id>...]
                [--migrate-full-vault] [--show-mcp-setup] [--register-mcp]
                [--no-instructions] [--no-sync]
                [--interactive|--yes|--dry-run] [--json]
  skillmux project init [path] [--name <group>] [--skill <skill_id>...]
                [--agent <name>...] [--no-sync]
                [--interactive|--yes|--dry-run] [--json]
  skillmux project <list|show|add-path|remove-path|pin|unpin|attach|detach>
  skillmux agent <list|add|remove|rehome>  (which agents this machine syncs skills to)
  skillmux core <pin|unpin> <skill_id>... [--yes] [--dry-run] [--json]
  skillmux skill which <skill_id>  (local vault shadow resolution; unrelated to MCP routing)
  skillmux config init --vault <path> --yes
                (bootstraps this machine's config on its own; not a
                prerequisite, since "skillmux init --vault" does the same)

Init agents:
  ${SUPPORTED_AGENT_IDS.join(", ")}
  ("skillmux init --show-mcp-setup" also prints the MCP registration
  snippet, independent of which agents you select. A tool not in this
  list isn't supported by init yet — see "skillmux init --help".)

Operations:
  skillmux report [--context <name> | --server <url> | --db <path>] --since <window> [--json]
  skillmux audit prune [--older-than <window>] [--dry-run] [--yes] [--json]
  skillmux eval promote --since <window> [--out <path>] [--dry-run] [--yes] [--json]
  skillmux outdated [--allow-local-source] [--json]
  skillmux update [skill-id] [--yes] [--dry-run] [--force] [--allow-local-source] [--fail-on low|medium|high|none] [--json]

Commands:
  ${KNOWN_COMMANDS.join(", ")}

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
      throw unknownOptionError("serve", option);
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

async function runEval(options: { isJson: boolean; adapter: ContextAdapter }): Promise<void> {
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
