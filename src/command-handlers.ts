import { unknownOptionError, usageError } from "./arg-errors";
import { createContextAdapter, type ContextAdapter } from "./adapters";
import { createClients } from "./clients";
import { loadConfig } from "./config";
import type { ResolvedContext } from "./context";
import type { CommandName } from "./command-registry";
import { runAgent } from "./commands/agent";
import { runAudit } from "./commands/audit";
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
    const { transport, port, statsPort } = parseServeArgs(args);
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

  scan: ({ args, isJson }) => runScan(args, { isJson }),

  install: ({ args, isJson }) => runInstall(args, { isJson }),

  outdated: ({ args, isJson }) => runOutdated(args, { isJson }),

  update: ({ args, isJson }) => runUpdate(args, { isJson }),

  eval: async ({ subCommand, subArgs, isJson, isDryRun, adapter }) => {
    if (subCommand === "promote") {
      await runEvalPromote(subArgs, { isJson, dryRun: isDryRun, adapter });
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

  skill: ({ subCommand, subArgs }) => runSkill(subCommand, subArgs),

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
