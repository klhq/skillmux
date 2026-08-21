#!/usr/bin/env bun
import packageJson from "../package.json" with { type: "json" };
import { Database } from "bun:sqlite";
import { existsSync, lstatSync, mkdirSync, rmSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

import { createClients } from "./clients";
import {
  expandHome,
  loadConfig,
  migrateLegacyPaths,
  resolveConfigPath,
} from "./config";
import { openIndex } from "./db";
import { diagnose } from "./doctor";
import { getEffectiveConfig } from "./config-service";
import { evalVault } from "./eval";
import {
  assessClientReadiness,
  detectInstalledClients,
  planClientSurfaces,
  resolveBuiltInTarget,
  SUPPORTED_CLIENT_IDS,
  type ClientId,
  type ReadinessAxis,
} from "./init-clients";
import {
  applyInstructionPlan,
  planInstructionSetup,
  rollbackInstructionPlan,
} from "./init-instructions";
import {
  applyInit,
  deriveTargetName,
  detectSurfaces,
  planInitManifest,
  printLastMile,
  surfaceCandidates,
} from "./init";
import {
  cloneToTemp,
  deriveRepoName,
  installIntoVault,
  resolveRepoSource,
  resolveSkillDir,
  validateSkillCandidate,
} from "./install";
import {
  parseManifest,
  resolveManifestPath,
  serializeManifest,
  validateManifest,
} from "./manifest";
import { downloadLocalModels } from "./models";

import {
  parseCommaList,
  promptMultiSelect,
  promptText,
  shouldUseWizard,
} from "./prompts";
import { backfillEmbeddings, configure, rebuildIndex } from "./router-core";
import {
  renderScanJson,
  renderScanText,
  scanExitCode,
  scanPath,
  type ScanSeverity,
} from "./scan";
import {
  applyConfigInit,
  inspectVault,
  planConfigInit,
  rollbackConfigInit,
  type ConfigInitPlan,
} from "./setup";
import { getStats, renderStatsText, type StatsResponse } from "./stats";
import {
  installPostMergeHook,
  restoreMonolith as restoreMonolithTarget,
  syncProjectTargets,
  syncTarget,
  writeLocalVaultMarker,
} from "./sync";
import { scanVault, vaultResolutionOrder } from "./vault";

import {
  addContext,
  getCurrentContext,
  listContexts,
  removeContext,
  resolveTarget,
  useContext,
  type ResolvedTarget,
} from "./context";
import { createTargetAdapter, type TargetAdapter } from "./adapters";
import {
  emitSuccess,
  CliError,
  formatJsonEnvelope,
  isInteractive,
  mapExitCode,
  renderTable,
  renderTargetBanner,
  suggestCorrection,
} from "./output";
import { generateCompletions, type ShellType } from "./completions";
import { handleConfigCommand } from "./commands/config";
import { runCore } from "./commands/core";
import { configuredTargetForSurface, runProject } from "./commands/project";
import { confirmAction, confirmIfNeeded } from "./commands/shared";
import { runTarget } from "./commands/target";

const KNOWN_COMMANDS = [
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
  "scan",
  "install",
  "eval",
  "doctor",
  "models",
  "skill",
  "local-vault",
];

function isDockerHostManagementCommand(command: string, subCommand: string): boolean {
  if (
    [
      "init",
      "sync",
      "install",
      "project",
      "target",
      "core",
      "local-vault",
      "models",
      "context",
      "eval",
    ].includes(command)
  ) {
    return true;
  }

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

  let resolvedTarget: ResolvedTarget = { type: "local", name: "local" };

  if (
    process.env.RUNNING_IN_DOCKER === "true" &&
    isDockerHostManagementCommand(command, subCommand)
  ) {
    handleError(containerCommandUnsupported(command, subCommand), {
      target: resolvedTarget,
      isJson,
      isVerbose,
    });
    return;
  }

  // Only resolve target if command is target-aware or context/config
  const isLocalConfigInit = command === "config" && rawArgv[1] === "init";
  if (
    (["context", "config"].includes(command) &&
      !isLocalConfigInit) ||
    flagContext ||
    flagServer
  ) {
    try {
      resolvedTarget = await resolveTarget({
        context: flagContext,
        server: flagServer,
      });
    } catch (err: any) {
      handleError(err, { target: resolvedTarget, isJson, isVerbose });
      return;
    }
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
        const { transport, port } = parseServeArgs(rawArgv.slice(1));
        const handle = await startServer({ transport, port });
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
        await runReport(rawArgv.slice(1), { isJson });
        break;
      case "scan":
        await runScan(rawArgv.slice(1), { isJson });
        break;
      case "install":
        await runInstall(rawArgv.slice(1), { isJson });
        break;
      case "eval":
        await runEval({ isJson });
        break;
      case "doctor":
        await runDoctor({ isJson });
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
          : `usage: skillmux <serve|index|sync|init|project|target|core pin/unpin|report|scan|install|eval|doctor|skill which|local-vault init|config show|models download>`;
        throw new Error(msg);
      }
    }
  } catch (err: any) {
    handleError(err, { target: resolvedTarget, isJson, isVerbose });
  }
}

async function handleContextCommand(
  sub: string,
  args: string[],
  ctx: { target: ResolvedTarget; isJson: boolean },
) {
  if (sub === "list") {
    const contexts = await listContexts();
    emitSuccess({ isJson: ctx.isJson, target: ctx.target }, contexts, () => {
      renderTargetBanner(ctx.target);
      renderTable(
        [
          { key: "name", header: "NAME" },
          { key: "server", header: "SERVER" },
          { key: "token_env", header: "TOKEN_ENV" },
          { key: "isDefault", header: "DEFAULT" },
        ],
        contexts.map((c) => ({
          ...c,
          token_env: c.token_env ?? "-",
          isDefault: c.isDefault ? "*" : "",
        })),
      );
    });
    return;
  }

  if (sub === "current") {
    const current = await getCurrentContext();
    emitSuccess({ isJson: ctx.isJson, target: ctx.target }, current, () => {
      renderTargetBanner(ctx.target);
      console.log(`Current context: ${current.name} (${current.server})`);
    });
    return;
  }

  if (sub === "add") {
    const name = args[0];
    let server: string | undefined;
    let tokenEnv: string | undefined;
    for (let i = 1; i < args.length; i++) {
      if (args[i] === "--server") server = args[++i];
      else if (args[i] === "--token-env") tokenEnv = args[++i];
    }
    if (!name || !server) {
      throw new Error(
        "usage: skillmux context add <name> --server <url> [--token-env <env_name>]",
      );
    }
    await addContext(name, { server, token_env: tokenEnv });
    emitSuccess(
      { isJson: ctx.isJson, target: ctx.target },
      { name, server, token_env: tokenEnv },
      () => {
        console.log(`Added context "${name}" -> ${server}`);
      },
    );
    return;
  }

  if (sub === "use") {
    const name = args[0];
    if (!name) throw new Error("usage: skillmux context use <name>");
    await useContext(name);
    emitSuccess(
      { isJson: ctx.isJson, target: ctx.target },
      { default_context: name },
      () => {
        console.log(`Switched default context to "${name}"`);
      },
    );
    return;
  }

  if (sub === "remove") {
    const name = args[0];
    if (!name) throw new Error("usage: skillmux context remove <name>");
    await removeContext(name);
    emitSuccess(
      { isJson: ctx.isJson, target: ctx.target },
      { removed: name },
      () => {
        console.log(`Removed context "${name}"`);
      },
    );
    return;
  }

  throw new Error("usage: skillmux context <add|list|current|use|remove>");
}

async function handleCompletionsCommand(shell: string) {
  if (shell !== "bash" && shell !== "zsh" && shell !== "fish") {
    throw new Error("usage: skillmux completions <bash|zsh|fish>");
  }
  console.log(generateCompletions(shell as ShellType));
}

function handleError(
  err: any,
  opts: { target: ResolvedTarget; isJson: boolean; isVerbose: boolean },
) {
  const code = mapExitCode(err);
  process.exitCode = code;

  const msg = err instanceof Error ? err.message : String(err);

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
      msg.startsWith("usage:") ||
        msg.startsWith("Unknown") ||
        msg.startsWith("error:")
        ? msg
        : `error: ${msg}`,
    );
    if (opts.isVerbose && err instanceof Error && err.stack) {
      console.error(err.stack);
    }
  }
}

function printHelp(): void {
  if (process.env.RUNNING_IN_DOCKER === "true") {
    console.log(`Skillmux server image

Default:
  serve --transport http

Supported commands:
  serve, index, doctor, report, scan, skill which
  config show|get|validate|diff|status

Native skill management:
  Install the Skillmux CLI on the host for init, install, pinning, and sync.

See docs/deployment.md for server deployment examples.`);
    return;
  }

  console.log(`usage: skillmux <command> [options]

Setup:
  skillmux config init --vault <path> --yes
  skillmux init [--client <name>...] [--target <name>...] [--dir <dir>]
                [--vault <path>] [--core <skill_id>...]
                [--migrate-full-vault] [--no-instructions] [--no-sync]
                [--interactive|--yes|--dry-run] [--json]
  skillmux project init [path] [--name <group>] [--skill <skill_id>...]
                [--client <name>...] [--target <name>...] [--no-sync]
                [--interactive|--yes|--dry-run] [--json]
  skillmux project <list|show|add-path|remove-path|pin|unpin|attach|detach>
  skillmux target <list|show|add|remove>
  skillmux core <pin|unpin> <skill_id>... [--yes] [--dry-run] [--json]
  skillmux skill which <skill_id>

Init clients:
  claude-code, codex, gemini-cli, opencode, github-copilot, windsurf,
  antigravity, goose, hermes, skillmux-mcp

Init targets:
  agent-skills, claude-code, codex, custom

Commands:
  serve, index, sync, init, project, target, core, report, scan, install, eval, doctor, skill,
  local-vault, config, models, context, completions`);
}

// ---------------------------------------------------------------------------
// Implementation of commands: serve, index, sync, init, report, scan, install, eval, doctor, models
// ---------------------------------------------------------------------------

type Transport = "stdio" | "http";

function parseServeArgs(args: string[]): {
  transport: Transport;
  port?: number;
} {
  let transport: Transport = "stdio";
  let port: number | undefined;
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
    } else {
      throw new Error(`unknown serve option: ${option}`);
    }
  }
  return { transport, port };
}

async function runIndex(): Promise<void> {
  const config = await loadConfig();
  configure({ config, clients: createClients(config) });
  const report = await rebuildIndex((skillId, error) => {
    console.error(
      `warning: keeping previous index entry for ${skillId}: ${error}`,
    );
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

async function runEval(options: { isJson: boolean }): Promise<void> {
  const config = await loadConfig();
  configure({ config, clients: createClients(config) });

  const report = await evalVault().catch((error: unknown) => {
    throw new Error(`eval requires local embeddings: ${String(error)}`);
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

async function runDoctor(options: { isJson: boolean }): Promise<void> {
  const effective = await getEffectiveConfig(resolveConfigPath());
  const report = await diagnose(effective.effective, process.env, effective.sources);
  emitSuccess({ isJson: options.isJson }, report, () => {
    console.log(`version: ${report.version}`);
    console.log(`runtime: ${report.runtime}`);
    console.log(`image variant: ${report.image_variant ?? "none"}`);
    console.log(`vault path: ${report.vault_path}`);
    console.log(`state directory: ${report.state_dir}`);
    console.log(`inference mode: ${report.mode}`);
    console.log(`routing capability: ${report.capability}`);
    console.log(`retrieval capability: ${report.retrieval_capability}`);
    for (const check of report.checks)
      console.log(
        `${check.ok ? "ok" : "fail"}: ${check.name} - ${check.detail}`,
      );
  });
  if (report.checks.some((check) => !check.ok)) process.exitCode = 1;
}

async function runSkill(subCommand: string, args: string[]): Promise<void> {
  if (subCommand !== "which") throw new Error("usage: skillmux skill <which>");
  await runWhich(args);
}

async function runWhich(args: string[]): Promise<void> {
  const skillId = args[0];
  if (!skillId) throw new Error("usage: skillmux skill which <skill_id>");
  const config = await loadConfig();
  const vaultPath = expandHome(config.vault_path);
  const localVaultPaths = config.local_vault_paths.map(expandHome);
  const roots = vaultResolutionOrder(vaultPath, localVaultPaths).filter(
    (root) => existsSync(join(root, skillId, "SKILL.md")),
  );
  if (roots.length === 0) {
    console.log(`${skillId}: not found in vault_path or local_vault_paths`);
    process.exitCode = 1;
    return;
  }
  console.log(`${skillId}: serving from ${roots[0]}`);
  for (const shadowedRoot of roots.slice(1))
    console.log(`  shadows: ${shadowedRoot}`);
}

async function runLocalVaultInit(
  args: string[],
  options: { isJson: boolean; dryRun: boolean },
): Promise<void> {
  const path = args[0];
  if (!path) throw new Error("usage: skillmux local-vault init <path> --yes");
  const expanded = expandHome(path);
  const config = await loadConfig();
  const localVaultPaths = config.local_vault_paths.map(expandHome);
  if (!localVaultPaths.includes(expanded)) {
    throw new Error(
      `"${path}" is not one of the configured local_vault_paths — add it to config.toml first`,
    );
  }
  if (!existsSync(expanded)) throw new Error(`"${path}" does not exist`);
  const markerPath = join(expanded, ".skillmux");
  if (options.dryRun) {
    emitSuccess(
      { isJson: options.isJson },
      {
        marker_path: markerPath,
        vault_path: expandHome(config.vault_path),
      },
      () =>
        console.log(
          `local-vault init: ${markerPath} (role: local_vault, vault_path: ${expandHome(config.vault_path)}) (dry-run)`,
        ),
    );
    return;
  }
  if (
    !(await confirmIfNeeded({
      confirmed: args.includes("--yes"),
      isJson: options.isJson,
      prompt: `Mark ${expanded} as a local_vault (role: local_vault, vault_path: ${expandHome(config.vault_path)})?`,
      nonInteractiveError:
        "skillmux local-vault init requires --yes when run non-interactively",
    }))
  )
    return;
  writeLocalVaultMarker(expanded, expandHome(config.vault_path));
  emitSuccess(
    { isJson: options.isJson },
    {
      marker_path: markerPath,
      vault_path: expandHome(config.vault_path),
    },
    () =>
      console.log(
        `wrote ${markerPath} (role: local_vault, vault_path: ${expandHome(config.vault_path)})`,
      ),
  );
}

async function runModelDownload(options: { isJson: boolean }): Promise<void> {
  const cacheDir = await downloadLocalModels(await loadConfig());
  emitSuccess({ isJson: options.isJson }, { cache_dir: cacheDir }, () =>
    console.log(`models ready in ${cacheDir}`),
  );
}

function parseSyncArgs(args: string[]): {
  dryRun: boolean;
  restoreMonolith: boolean;
  installHook: boolean;
} {
  let dryRun = false;
  let restoreMonolith = false;
  let installHook = false;
  for (const arg of args) {
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--restore-monolith") restoreMonolith = true;
    else if (arg === "--install-hook") installHook = true;
    else throw new Error(`unknown sync option: ${arg}`);
  }
  return { dryRun, restoreMonolith, installHook };
}

async function runSync(args: string[]): Promise<void> {
  const { dryRun, restoreMonolith, installHook } = parseSyncArgs(args);
  const config = await loadConfig();
  const vaultPath = expandHome(config.vault_path);

  if (installHook) {
    const result = installPostMergeHook(vaultPath);
    console.log(
      result.installed
        ? "installed post-merge hook"
        : "post-merge hook already installed",
    );
  }

  const manifestPath = resolveManifestPath(vaultPath);
  if (!manifestPath) {
    console.log("no skillmux.toml found at vault root — nothing to sync");
    return;
  }

  const manifest = parseManifest(await Bun.file(manifestPath).text());
  const localVaultPaths = config.local_vault_paths.map(expandHome);
  const { notes } = validateManifest(manifest, vaultPath, localVaultPaths);
  for (const note of notes) console.log(`note: ${note}`);

  const currentHost = hostname();
  for (const [targetName, target] of Object.entries(manifest.targets)) {
    if (target.host !== undefined && target.host !== currentHost) {
      console.log(
        `${targetName}: skipped (host ${target.host} does not match current host ${currentHost})`,
      );
      continue;
    }
    const targetDir = expandHome(target.dir);

    if (restoreMonolith) {
      const result = restoreMonolithTarget(targetDir, vaultPath);
      console.log(
        result.restored
          ? `${targetName}: restored to a vault symlink`
          : `${targetName}: not owned by skillmux, left untouched`,
      );
      continue;
    }

    const suffix = dryRun ? " (dry-run)" : "";
    const result = syncTarget(
      {
        vaultPath,
        targetDir,
        targetName,
        coreSkillIds: manifest.core.skills,
        localVaultPaths,
      },
      { dryRun },
    );
    console.log(
      `${targetName}: +${result.added.length} -${result.removed.length}${suffix}`,
    );

    if (target.project_groups.length > 0) {
      const allGroups = manifest.project ?? {};
      const projectGroups = Object.fromEntries(
        target.project_groups.map((name) => [name, allGroups[name]!]),
      );
      const projectResults = syncProjectTargets(
        { vaultPath, targetDir, targetName, projectGroups, localVaultPaths },
        { dryRun },
      );
      for (const projectResult of projectResults) {
        console.log(
          `  ${projectResult.group} -> ${projectResult.pinDir}: +${projectResult.added.length} -${projectResult.removed.length}${suffix}`,
        );
      }
    }
  }
}

function parseInitArgs(args: string[]): {
  targets: string[];
  clients: string[];
  coreSkillIds: string[];
  customPath?: string;
  migrateFullVault: boolean;
  skipInstructions: boolean;
  sync: boolean;
  vaultPath?: string;
  yes: boolean;
} {
  const targets: string[] = [];
  const clients: string[] = [];
  const coreSkillIds: string[] = [];
  let customPath: string | undefined;
  let migrateFullVault = false;
  let skipInstructions = false;
  let sync = true;
  let vaultPath: string | undefined;
  let yes = false;
  for (let i = 0; i < args.length; i++) {
    const option = args[i];
    if (option === "--target") {
      const value = args[i + 1];
      if (!value) throw new Error("--target requires a name");
      targets.push(value);
      i++;
    } else if (option === "--client") {
      const value = args[i + 1];
      if (!value) throw new Error("--client requires a name");
      clients.push(value);
      i++;
    } else if (option === "--vault") {
      const value = args[i + 1];
      if (!value) throw new Error("--vault requires a path");
      vaultPath = value;
      i++;
    } else if (option === "--dir") {
      const value = args[i + 1];
      if (!value) throw new Error("--dir requires a directory");
      customPath = value;
      i++;
    } else if (option === "--core") {
      const value = args[i + 1];
      if (!value) throw new Error("--core requires a skill_id");
      coreSkillIds.push(value);
      i++;
    } else if (
      option === "--dry-run" ||
      option === "--json" ||
      option === "--interactive"
    ) {
      continue;
    } else if (option === "--migrate-full-vault") {
      migrateFullVault = true;
    } else if (option === "--no-instructions") {
      skipInstructions = true;
    } else if (option === "--no-sync") {
      sync = false;
    } else if (option === "--yes") {
      yes = true;
    } else {
      throw new Error(`unknown init option: ${option}`);
    }
  }
  return {
    targets,
    clients,
    coreSkillIds,
    customPath,
    migrateFullVault,
    skipInstructions,
    sync,
    vaultPath,
    yes,
  };
}

async function runInit(
  args: string[],
  options: { isJson: boolean; dryRun: boolean },
): Promise<void> {
  const {
    targets: explicitTargets,
    clients: requestedClients,
    coreSkillIds,
    customPath,
    migrateFullVault,
    skipInstructions,
    sync,
    vaultPath: requestedVaultPath,
    yes,
  } = parseInitArgs(args);
  const guided = shouldUseWizard(args, {
    interactive: isInteractive(),
    json: options.isJson,
    dryRun: options.dryRun,
  });
  migrateLegacyPaths();
  const configPath = resolveConfigPath();
  let configPlan: ConfigInitPlan | undefined;
  let vaultPath: string;
  if (!existsSync(configPath)) {
    const bootstrapVaultPath =
      requestedVaultPath ??
      (!options.isJson && isInteractive() ? "~/skills" : undefined);
    if (!bootstrapVaultPath) {
      throw new Error(
        `machine config does not exist: ${configPath}; re-run with --vault <path>`,
      );
    }
    configPlan = planConfigInit(configPath, expandHome(bootstrapVaultPath));
    vaultPath = configPlan.vaultPath;
    if (!options.isJson) {
      console.log(`config create: ${configPath}`);
    }
  } else {
    const config = await loadConfig();
    vaultPath = expandHome(config.vault_path);
    if (requestedVaultPath && expandHome(requestedVaultPath) !== vaultPath) {
      throw new Error(
        `machine config already uses vault_path ${vaultPath}; --vault does not overwrite existing config`,
      );
    }
  }

  const vaultHealth = inspectVault(vaultPath);
  if (!vaultHealth.ok) {
    throw new Error(vaultHealth.message);
  }

  let selectedClients = requestedClients;
  if (guided) {
    const detected = detectInstalledClients({
      codexHome: process.env.CODEX_HOME
        ? expandHome(process.env.CODEX_HOME)
        : undefined,
    });
    const evidence = new Map(
      detected.map((item) => [item.client, item.evidence]),
    );
    selectedClients = await promptMultiSelect(
      "Which clients do you use?",
      SUPPORTED_CLIENT_IDS.map((client) => ({
        value: client,
        label: client,
        detail: evidence.has(client)
          ? `detected: ${evidence.get(client)}`
          : undefined,
        selected: evidence.has(client) || requestedClients.includes(client),
      })),
    );
  }
  let selectedCoreSkillIds = coreSkillIds;
  if (guided) {
    selectedCoreSkillIds = parseCommaList(
      await promptText(
        "Core skill IDs to add, comma-separated",
        coreSkillIds.join(","),
      ),
    );
  }

  const clientPlan = planClientSurfaces(selectedClients, {
    codexHome: process.env.CODEX_HOME
      ? expandHome(process.env.CODEX_HOME)
      : undefined,
  });
  const instructionPlan = planInstructionSetup(
    skipInstructions ? [] : clientPlan.clients.map((client) => client.id),
    {
      codexHome: process.env.CODEX_HOME
        ? expandHome(process.env.CODEX_HOME)
        : undefined,
    },
  );
  const instructionReadiness: Partial<Record<ClientId, ReadinessAxis>> = {};
  for (const change of instructionPlan.changes) {
    for (const client of change.clients) {
      instructionReadiness[client] = {
        status: change.status === "unchanged" ? "ready" : "planned",
        detail: change.path,
      };
    }
  }
  for (const manual of instructionPlan.manual) {
    instructionReadiness[manual.client] = {
      status: "manual",
      detail: manual.reason,
    };
  }
  const builtInNames = new Set([
    "agent-skills",
    "claude-code",
    "codex",
    "custom",
    "agents",
    "claude",
  ]);
  const explicitSurfaceTargets = explicitTargets
    .filter((name) => builtInNames.has(name))
    .map((name) =>
      resolveBuiltInTarget(name, {
        codexHome: process.env.CODEX_HOME
          ? expandHome(process.env.CODEX_HOME)
          : undefined,
        customPath: customPath ? expandHome(customPath) : undefined,
      }),
    );
  if (customPath && !explicitTargets.includes("custom")) {
    throw new Error("--dir may only be used with --target custom");
  }
  for (const target of explicitSurfaceTargets) {
    if (target.warning) console.error(`warning: ${target.warning}`);
  }
  const targetByPath = new Map(
    explicitSurfaceTargets.map(
      (target) => [target.path, target.targetName] as const,
    ),
  );
  const existingManifestPath = resolveManifestPath(vaultPath);
  const existingManifest = existingManifestPath
    ? parseManifest(await Bun.file(existingManifestPath).text())
    : undefined;
  for (const surface of clientPlan.surfaces) {
    if (!targetByPath.has(surface.path)) {
      targetByPath.set(
        surface.path,
        existingManifest
          ? (configuredTargetForSurface(existingManifest, surface) ??
              surface.targetName)
          : surface.targetName,
      );
    }
  }
  const candidatePaths = [
    ...new Set([
      ...surfaceCandidates().map(expandHome),
      ...targetByPath.keys(),
    ]),
  ];
  const candidates = detectSurfaces(candidatePaths, vaultPath);
  if (!options.isJson) {
    for (const candidate of candidates) {
      const name =
        targetByPath.get(candidate.path) ?? deriveTargetName(candidate.path);
      if (candidate.state === "missing") {
        console.log(`${name} (${candidate.path}): not found`);
        continue;
      }
      if (candidate.state === "broken-symlink") {
        console.log(`${name} (${candidate.path}): broken symlink`);
        continue;
      }
      if (candidate.state === "full-vault") {
        console.log(
          `${name} (${candidate.path}): full-vault -> ${candidate.canonicalPath}`,
        );
        continue;
      }
      if (candidate.state === "external-symlink") {
        console.log(
          `${name} (${candidate.path}): external symlink -> ${candidate.canonicalPath}`,
        );
        continue;
      }
      if (candidate.state === "unsupported") {
        console.log(
          `${name} (${candidate.path}): unsupported filesystem entry`,
        );
        continue;
      }
      const kind = "real dir";
      const marked = candidate.alreadyMarked
        ? ", already skillmux-managed"
        : "";
      console.log(
        `${name} (${candidate.path}): ${kind}, ${candidate.skillCount} skills${marked}`,
      );
    }
    for (const readiness of assessClientReadiness(
      clientPlan,
      instructionReadiness,
    )) {
      console.log(`\n${readiness.client} readiness:`);
      console.log(
        `  skill surface: ${readiness.skillSurface.status} — ${readiness.skillSurface.detail}`,
      );
      console.log(
        `  MCP registration: ${readiness.mcpRegistration.status} — ${readiness.mcpRegistration.detail}`,
      );
      console.log(
        `  instructions: ${readiness.instructionSetup.status} — ${readiness.instructionSetup.detail}`,
      );
    }
    for (const change of instructionPlan.changes) {
      console.log(
        `instructions ${change.status}: ${change.path} (${change.clients.join(", ")})`,
      );
    }
    for (const manual of instructionPlan.manual) {
      console.log(`instructions manual: ${manual.client} — ${manual.reason}`);
    }
  }

  const requestedTargets = [
    ...new Set([
      ...explicitTargets.filter((name) => !builtInNames.has(name)),
      ...targetByPath.values(),
    ]),
  ];
  const hasInstructionWrites = instructionPlan.changes.some(
    (change) => change.status !== "unchanged",
  );
  const hasConfigWrite = configPlan?.action === "create";
  const hasChanges = !(
    requestedTargets.length === 0 &&
    !hasInstructionWrites &&
    selectedCoreSkillIds.length === 0 &&
    !hasConfigWrite
  );

  const byName = new Map(
    candidates
      .filter(
        (candidate) =>
          candidate.deliveryMode === "managed-pins" ||
          (migrateFullVault && candidate.state === "full-vault"),
      )
      .map(
        (candidate) =>
          [
            targetByPath.get(candidate.path) ??
              deriveTargetName(candidate.path),
            candidate,
          ] as const,
      ),
  );
  const allCandidatesByName = new Map(
    candidates.map(
      (candidate) =>
        [
          targetByPath.get(candidate.path) ?? deriveTargetName(candidate.path),
          candidate,
        ] as const,
    ),
  );
  for (const name of requestedTargets) {
    if (!byName.has(name)) {
      if (allCandidatesByName.get(name)?.state === "full-vault") {
        throw new Error(
          `target "${name}" is a full-vault surface; re-run with --migrate-full-vault to convert it to managed pins`,
        );
      }
      throw new Error(
        `unknown --target "${name}": not among detected surfaces`,
      );
    }
  }

  const confirmedTargets = requestedTargets.map((name) => {
    const candidate = byName.get(name)!;
    return {
      name,
      dir: candidate.path,
      ...(candidate.state === "full-vault" ? { migrateFullVault: true } : {}),
    };
  });
  const plannedManifest = planInitManifest(
    vaultPath,
    confirmedTargets,
    selectedCoreSkillIds,
  );
  const serializedPlan = {
    vault_path: vaultPath,
    config: configPlan
      ? { path: configPlan.configPath, action: configPlan.action }
      : { path: configPath, action: "preserve" },
    clients: clientPlan.clients.map((client) => client.id),
    targets: confirmedTargets,
    core: plannedManifest.core.skills,
    instructions: instructionPlan.changes.map(({ path, clients, status }) => ({
      path,
      clients,
      status,
    })),
    manual: instructionPlan.manual,
  };
  if (!hasChanges) {
    if (options.isJson) {
      console.log(
        JSON.stringify({
          schema_version: 1,
          ok: true,
          command: "init",
          phase: "plan",
          dry_run: options.dryRun,
          applied: false,
          plan: serializedPlan,
        }),
      );
    } else {
      console.log("\nno managed-pins surface selected — nothing written.");
    }
    return;
  }
  if (!options.isJson) {
    for (const target of confirmedTargets.filter(
      (target) => target.migrateFullVault,
    )) {
      console.log(
        `full-vault migration ${target.name}: ${vaultHealth.skillCount} visible skills -> ` +
          `${plannedManifest.core.skills.length} core ${plannedManifest.core.skills.length === 1 ? "skill" : "skills"} after sync`,
      );
    }
  }
  if (options.dryRun) {
    if (options.isJson) {
      console.log(
        JSON.stringify({
          schema_version: 1,
          ok: true,
          command: "init",
          phase: "plan",
          dry_run: true,
          applied: false,
          plan: serializedPlan,
        }),
      );
    } else {
      console.log(
        `\ndry-run: ${confirmedTargets.length} target(s), ` +
          `${instructionPlan.changes.filter((change) => change.status !== "unchanged").length} instruction file(s), ` +
          `core: ${plannedManifest.core.skills.join(", ") || "(unchanged)"}`,
      );
    }
    return;
  }

  if (!yes) {
    if (!options.isJson && isInteractive()) {
      if (guided) {
        console.log("\nReview");
        console.log(`  clients: ${selectedClients.join(", ") || "(none)"}`);
        console.log(
          `  targets: ${confirmedTargets.map((target) => `${target.name} -> ${target.dir}`).join(", ") || "(none)"}`,
        );
        console.log(
          `  instructions: ${instructionPlan.changes.filter((change) => change.status !== "unchanged").length} file(s)`,
        );
        console.log(
          `  core: ${plannedManifest.core.skills.join(", ") || "(none)"}`,
        );
        console.log(`  sync: ${sync ? "yes" : "no"}`);
        if (!(await confirmAction("Apply this setup plan?"))) {
          console.log("init cancelled");
          return;
        }
      } else {
        const prompts = [
          ...confirmedTargets.map(
            (target) => `Adopt ${target.name} at ${target.dir}?`,
          ),
          ...instructionPlan.changes
            .filter((change) => change.status !== "unchanged")
            .map(
              (change) => `${change.status} instruction file ${change.path}?`,
            ),
          ...(hasConfigWrite ? [`Create machine config ${configPath}?`] : []),
          ...(selectedCoreSkillIds.length > 0
            ? [`Pin core skills: ${selectedCoreSkillIds.join(", ")}?`]
            : []),
        ];
        for (const prompt of prompts) {
          if (!(await confirmAction(prompt))) {
            console.log("init cancelled; nothing written");
            return;
          }
        }
      }
    } else {
      throw new Error(
        "skillmux init requires --yes before applying target, instruction, or core changes non-interactively",
      );
    }
  }

  let configCreated = false;
  let instructionsApplied = false;
  const applyAdditional = () => {
    try {
      if (configPlan?.action === "create") {
        configCreated = applyConfigInit(configPlan) === "created";
      }
      if (hasInstructionWrites) {
        applyInstructionPlan(instructionPlan);
        instructionsApplied = true;
      }
    } catch (error) {
      if (configCreated && configPlan) rollbackConfigInit(configPlan);
      configCreated = false;
      throw error;
    }
  };
  const rollbackAdditional = () => {
    if (instructionsApplied) rollbackInstructionPlan(instructionPlan);
    if (configCreated && configPlan) rollbackConfigInit(configPlan);
  };

  if (confirmedTargets.length === 0 && selectedCoreSkillIds.length === 0) {
    applyAdditional();
  } else {
    applyInit(
      vaultPath,
      confirmedTargets,
      hasInstructionWrites || hasConfigWrite
        ? {
            apply: applyAdditional,
            rollback: rollbackAdditional,
          }
        : undefined,
      selectedCoreSkillIds,
    );
  }

  if (options.isJson) {
    console.log(
      JSON.stringify({
        schema_version: 1,
        ok: true,
        command: "init",
        phase: "result",
        dry_run: false,
        applied: true,
        plan: serializedPlan,
        result: {
          config_created: configCreated,
          targets_adopted: confirmedTargets.map((target) => target.name),
          instructions_changed: instructionPlan.changes
            .filter((change) => change.status !== "unchanged")
            .map((change) => change.path),
          core: plannedManifest.core.skills,
        },
      }),
    );
    return;
  }
  if (configCreated) console.log(`created ${configPath}`);
  if (confirmedTargets.length > 0) {
    console.log(
      `\nwrote ${join(vaultPath, "skillmux.toml")}, adopted: ${confirmedTargets.map((t) => t.name).join(", ")}`,
    );
  } else if (selectedCoreSkillIds.length > 0) {
    console.log(`\nwrote ${join(vaultPath, "skillmux.toml")}`);
  }
  if (plannedManifest.core.skills.length === 0 && confirmedTargets.length > 0) {
    console.log("next: skillmux core pin <skill_id> --yes");
  }
  if (confirmedTargets.length > 0) console.log("next: skillmux sync");
  if (
    selectedClients.length === 0 ||
    selectedClients.includes("skillmux-mcp")
  ) {
    console.log(`\n${printLastMile()}`);
  }
  if (guided && sync && confirmedTargets.length > 0) await runSync([]);
}

function parseReportArgs(args: string[]): {
  server?: string;
  db?: string;
  since?: string;
} {
  let server: string | undefined;
  let db: string | undefined;
  let since: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const option = args[i];
    const value = args[i + 1];
    if (option === "--server") {
      if (!value) throw new Error("--server requires a URL");
      server = value;
      i++;
    } else if (option === "--db") {
      if (!value) throw new Error("--db requires a path");
      db = value;
      i++;
    } else if (option === "--since") {
      if (!value) throw new Error("--since requires a window");
      since = value;
      i++;
    } else if (option === "--json") {
      // handled globally by main()'s isJson flag; recognized here so it isn't rejected
    } else {
      throw new Error(`unknown report option: ${option}`);
    }
  }
  if (server && db) throw new Error("--server and --db are mutually exclusive");
  return { server, db, since };
}

async function runReport(
  args: string[],
  options: { isJson: boolean },
): Promise<void> {
  const { server, db: dbPath, since } = parseReportArgs(args);
  if (!since)
    throw new Error(
      "usage: skillmux report [--server <url> | --db <path>] --since <window> [--json]",
    );

  if (server) {
    const url = `${server.replace(/\/$/, "")}/stats?since=${encodeURIComponent(since)}`;
    const res = await fetch(url);
    if (!res.ok)
      throw new Error(
        `skillmux report --server failed: ${res.status} ${await res.text()}`,
      );
    const stats = (await res.json()) as StatsResponse;
    emitSuccess({ isJson: options.isJson }, stats, () =>
      console.log(renderStatsText(stats)),
    );
    return;
  }

  const db = dbPath
    ? new Database(dbPath, { readonly: true })
    : openIndex(expandHome((await loadConfig()).state_dir));
  const stats = getStats(db, since);
  emitSuccess({ isJson: options.isJson }, stats, () =>
    console.log(renderStatsText(stats)),
  );
  db.close();
}

function parseScanArgs(args: string[]): {
  path?: string;
  format: "text" | "json";
  failOn?: ScanSeverity;
} {
  let path: string | undefined;
  let format: "text" | "json" = "text";
  let failOn: ScanSeverity | undefined;
  for (let i = 0; i < args.length; i++) {
    const option = args[i];
    if (option === "--format") {
      const value = args[++i];
      if (value !== "text" && value !== "json")
        throw new Error("--format must be text or json");
      format = value;
    } else if (option === "--fail-on") {
      const value = args[++i];
      if (value !== "low" && value !== "medium" && value !== "high") {
        throw new Error("--fail-on must be low, medium, or high");
      }
      failOn = value;
    } else if (option === "--json") {
      // handled globally by main()'s isJson flag; recognized here so it isn't rejected
    } else if (option?.startsWith("--")) {
      throw new Error(`unknown scan option: ${option}`);
    } else if (path !== undefined) {
      throw new Error("skillmux scan accepts at most one <path> argument");
    } else {
      path = option;
    }
  }
  return { path, format, failOn };
}

async function runScan(
  args: string[],
  options: { isJson: boolean },
): Promise<void> {
  const { path, format, failOn } = parseScanArgs(args);
  const rootPath = path
    ? expandHome(path)
    : expandHome((await loadConfig()).vault_path);
  const result = await scanPath(rootPath);
  emitSuccess({ isJson: options.isJson }, result, () => {
    console.log(
      format === "json" ? renderScanJson(result) : renderScanText(result),
    );
  });
  process.exitCode = scanExitCode(result.findings, failOn);
}

function parseInstallArgs(args: string[]): {
  repo?: string;
  force: boolean;
  dryRun: boolean;
  failOn?: ScanSeverity;
} {
  let repo: string | undefined;
  let force = false;
  let dryRun = false;
  let failOn: ScanSeverity | undefined;
  for (let i = 0; i < args.length; i++) {
    const option = args[i];
    if (option === "--force") force = true;
    else if (option === "--dry-run") dryRun = true;
    else if (option === "--fail-on") {
      const value = args[++i];
      if (value !== "low" && value !== "medium" && value !== "high") {
        throw new Error("--fail-on must be low, medium, or high");
      }
      failOn = value;
    } else if (option === "--json") {
      // handled globally by main()'s isJson flag; recognized here so it isn't rejected
    } else if (option?.startsWith("--")) {
      throw new Error(`unknown install option: ${option}`);
    } else if (repo !== undefined) {
      throw new Error("skillmux install accepts at most one <repo> argument");
    } else {
      repo = option;
    }
  }
  return { repo, force, dryRun, failOn };
}

async function runInstall(
  args: string[],
  options: { isJson: boolean },
): Promise<void> {
  const { repo, force, dryRun, failOn } = parseInstallArgs(args);
  if (!repo) {
    throw new Error(
      "usage: skillmux install <repo>[/path] [--force] [--fail-on low|medium|high] [--dry-run] [--json]",
    );
  }

  const source = resolveRepoSource(repo);
  const cloneDir = await cloneToTemp(source.url);
  try {
    const resolved = resolveSkillDir(
      cloneDir,
      deriveRepoName(source.url),
      source.skillPath,
    );
    const { findings } = await validateSkillCandidate(
      resolved.skillId,
      resolved.dir,
    );
    if (!options.isJson) console.log(renderScanText({ scanned: 1, findings }));

    if (scanExitCode(findings, failOn) !== 0) {
      process.exitCode = 1;
      console.error(
        `aborting install: a finding met the --fail-on ${failOn} threshold`,
      );
      return;
    }

    const vaultPath = expandHome((await loadConfig()).vault_path);
    if (dryRun) {
      const plannedPath = join(vaultPath, resolved.skillId);
      emitSuccess(
        { isJson: options.isJson },
        { skill_id: resolved.skillId, would_install_at: plannedPath },
        () =>
          console.log(
            `dry-run: would install "${resolved.skillId}" into ${plannedPath}`,
          ),
      );
      return;
    }

    const targetDir = installIntoVault(
      vaultPath,
      resolved.skillId,
      resolved.dir,
      force,
    );
    emitSuccess(
      { isJson: options.isJson },
      { skill_id: resolved.skillId, installed_at: targetDir },
      () => console.log(`installed "${resolved.skillId}" into ${targetDir}`),
    );
  } finally {
    rmSync(cloneDir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  await main();
}
