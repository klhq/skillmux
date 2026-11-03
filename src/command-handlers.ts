import { unknownOptionError, usageError } from "./arg-errors";
import { createContextAdapter, type ContextAdapter } from "./adapters";
import { createClients } from "./clients";
import { expandHome, loadConfig } from "./config";
import type { ResolvedContext } from "./context";
import type { CommandName } from "./command-registry";
import { runAgent } from "./commands/agent";
import { runAudit } from "./commands/audit";
import { runVault } from "./commands/vault";
import { applyServeOverrides, parseServeArgs, verifyServeOverrides } from "./serve-args";
import { handleConfigCommand } from "./commands/config";
import { handleContextCommand } from "./commands/context";
import { runCore } from "./commands/core";
import { runDoctor } from "./commands/doctor";
import { runEvalPromote } from "./commands/eval";
import { runInit } from "./commands/init";
import { runInstall } from "./commands/install";
import { runLocalVaultInit } from "./commands/local-vault";
import { runModelDownload } from "./commands/models";
import { runOutdated } from "./commands/outdated";
import { runProject } from "./commands/project";
import { runReport } from "./commands/report";
import { runScan } from "./commands/scan";
import { runSkill } from "./commands/skill";
import { runStatus } from "./commands/status";
import { runSync } from "./commands/sync";
import { runUpdate } from "./commands/update";
import { generateCompletions, type ShellType } from "./completions";
import { emitSuccess, warn } from "./output";
import { backfillEmbeddings, configure, rebuildIndex } from "./router-core";

/**
 * Everything a command handler needs from main(): the parsed global flags, the
 * resolved context and its adapter, and the arguments after the command name.
 */
export interface CommandInvocation {
  /** Arguments after the command, including the subcommand: `skillmux a b c` gives [b, c]. */
  args: string[];
  /** The first argument, or "" when it is a flag. */
  subCommand: string;
  /** Arguments after the subcommand: `skillmux a b c` gives [c]. */
  subArgs: string[];
  isJson: boolean;
  isDryRun: boolean;
  isVerbose: boolean;
  allowInsecure: boolean;
  context: ResolvedContext;
  adapter: ContextAdapter;
}

export type CommandHandler = (invocation: CommandInvocation) => Promise<void>;


/**
 * One handler per registered command. Typed as Record<CommandName, ...>, so
 * registering a command without a handler, or adding a handler for a command
 * that is not registered, is a compile error rather than an "Unknown command"
 * at runtime.
 */
export const HANDLERS: Record<CommandName, CommandHandler> = {
  context: ({ subCommand, subArgs, context, isJson }) =>
    handleContextCommand(subCommand, subArgs, { context, isJson }),

  config: ({ adapter, subCommand, subArgs, context, isJson, isDryRun }) =>
    handleConfigCommand(adapter, subCommand, subArgs, { context, isJson, dryRun: isDryRun }),

  completions: ({ subCommand }) => handleCompletionsCommand(subCommand),

  serve: async ({ args }) => {
    const { startServer } = await import("./server");
    const { transport, port, statsPort, overrides } = parseServeArgs(args);
    if (Object.keys(overrides).length > 0) {
      applyServeOverrides(overrides);
      verifyServeOverrides(overrides, await loadConfig());
    }
    let handle: Awaited<ReturnType<typeof startServer>>;
    try {
      handle = await startServer({ transport, port, statsPort });
    } catch (error) {
      // A refusal such as an unsafe bind happens after the config watcher and
      // other background work are already running, which keeps the process
      // alive without serving. A supervisor would see a live service that
      // answers nothing, so exit once the error has been reported.
      setTimeout(() => process.exit(process.exitCode || 1), 500).unref();
      throw error;
    }
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
  },

  index: () => runIndex(),

  sync: ({ args }) => runSync(args),

  init: ({ args, isJson, isDryRun }) => runInit(args, { isJson, dryRun: isDryRun }),

  project: ({ subCommand, subArgs, isJson, isDryRun }) =>
    runProject(subCommand, subArgs, { isJson, dryRun: isDryRun, sync: runSync }),

  agent: ({ subCommand, subArgs, isJson, isDryRun }) =>
    runAgent(subCommand, subArgs, { isJson, dryRun: isDryRun }),

  core: ({ subCommand, subArgs, isJson, isDryRun }) =>
    runCore(subCommand, subArgs, { isJson, dryRun: isDryRun }),

  report: ({ args, isJson, context, allowInsecure, adapter }) =>
    runReport(args, { isJson, context, allowInsecure, adapter }),

  audit: ({ subCommand, subArgs, isJson, isDryRun, context, adapter }) =>
    runAudit(subCommand, subArgs, { isJson, dryRun: isDryRun, context, adapter }),

  vault: ({ subCommand, subArgs, isJson, isDryRun, context, adapter }) =>
    runVault(subCommand, subArgs, {
      isJson,
      dryRun: isDryRun,
      context,
      adapter,
      resolveVaultPath: async () => expandHome((await loadConfig()).vault_path),
    }),

  scan: ({ args, isJson }) => runScan(args, { isJson }),

  install: ({ args, isJson }) => runInstall(args, { isJson }),

  outdated: ({ args, isJson }) => runOutdated(args, { isJson }),

  update: ({ args, isJson }) => runUpdate(args, { isJson }),

  eval: async ({ subCommand, subArgs, isJson, isDryRun, context, adapter }) => {
    if (subCommand === "promote") {
      await runEvalPromote(subArgs, { isJson, dryRun: isDryRun, adapter, isLocalContext: context.type === "local" });
    } else if (subCommand === "") {
      await runEval({ isJson, adapter });
    } else {
      throw usageError(
        `unknown eval subcommand "${subCommand}"`,
        "usage: skillmux eval [promote --since <window> [--out <path>] [--dry-run] [--yes] [--json]]",
      );
    }
  },

  doctor: ({ args, isJson, isVerbose, context, adapter }) =>
    runDoctor({ isJson, verbose: isVerbose, context, adapter, args }),

  models: async ({ subCommand, isJson }) => {
    if (subCommand !== "download") {
      throw usageError(
        subCommand ? `unknown models subcommand "${subCommand}"` : "missing subcommand",
        "usage: skillmux models download",
      );
    }
    await runModelDownload({ isJson });
  },

  skill: ({ subCommand, subArgs, isJson }) => runSkill(subCommand, subArgs, { isJson }),

  status: ({ args, isJson }) => runStatus(args, { isJson }),

  "local-vault": async ({ subCommand, subArgs, isJson, isDryRun }) => {
    if (subCommand !== "init") {
      throw usageError(
        subCommand ? `unknown local-vault subcommand "${subCommand}"` : "missing subcommand",
        "usage: skillmux local-vault init <path>",
      );
    }
    await runLocalVaultInit(subArgs, { isJson, dryRun: isDryRun });
  },
};

/**
 * Commands that no longer exist but are still recognized so the error can say
 * what replaced them. They are deliberately not in the registry, so they have
 * no help, completion, or context classification.
 */
export const REMOVED_COMMANDS: Record<string, (subCommand: string) => string> = {
  calibrate: () =>
    'skillmux calibrate was removed. Threshold calibration was removed; use "skillmux eval" for ranking evaluation.',
  which: (subCommand) =>
    `skillmux which is removed - use "skillmux skill which ${subCommand || "<skill_id>"}" instead`,
  manifest: (subCommand) =>
    `skillmux manifest is removed - use "skillmux core ${subCommand || "pin|unpin"}" for [core] skills, or "skillmux project ${subCommand || "pin|unpin"} <group>" for [project.*] skills`,
  target: () =>
    '"skillmux target" was replaced by "skillmux agent": list agents in config.toml ' +
    '(agents = [...]) instead of naming directories. See "skillmux agent --help"',
};

/** The handler for a registered command, or undefined. Own properties only, so "constructor" is not a command. */
export function findHandler(command: string): CommandHandler | undefined {
  return Object.hasOwn(HANDLERS, command) ? HANDLERS[command as CommandName] : undefined;
}


async function handleCompletionsCommand(shell: string) {
  if (shell !== "bash" && shell !== "zsh" && shell !== "fish") {
    throw usageError(shell ? `unsupported shell "${shell}"` : "missing <shell> argument", "usage: skillmux completions <bash|zsh|fish>");
  }
  console.log(generateCompletions(shell as ShellType));
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
