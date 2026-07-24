#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { existsSync, lstatSync, mkdirSync, rmSync } from "node:fs";
import { hostname } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { generateDataset } from "./dataset-generator";

import { createClients } from "./clients";
import { expandHome, loadConfig, migrateLegacyPaths, resolveConfigPath } from "./config";
import { openIndex } from "./db";
import { diagnose } from "./doctor";
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
  pinCore,
  pinProject,
  resolveManifestPath,
  serializeManifest,
  unpinCore,
  unpinProject,
  upsertProject,
  updateProjectPaths,
  updateProjectTargets,
  validateManifest,
  writeManifestAtomic,
} from "./manifest";
import { downloadLocalModels } from "./models";
import { resolveProjectDirectory, suggestProjectName } from "./project-setup";
import { parseCommaList, promptMultiSelect, promptText, shouldUseWizard } from "./prompts";
import { backfillEmbeddings, configure, rebuildIndex } from "./router-core";
import { renderScanJson, renderScanText, scanExitCode, scanPath, type ScanSeverity } from "./scan";
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
import { formatJsonEnvelope, isInteractive, mapExitCode, renderTable, renderTargetBanner, suggestCorrection } from "./output";
import { generateCompletions, type ShellType } from "./completions";

const KNOWN_COMMANDS = [
  "context",
  "config",
  "calibrate",
  "completions",
  "serve",
  "index",
  "sync",
  "init",
  "project",
  "target",
  "report",
  "scan",
  "install",
  "eval",
  "doctor",
  "models",
  "which",
  "manifest",
  "local-vault",
];

async function main() {
  const rawArgv = Bun.argv.slice(2);

  let isJson = process.env.SKILLMUX_JSON === "true";
  let allowInsecure = false;
  let isVerbose = false;
  let flagContext: string | undefined;
  let flagServer: string | undefined;
  let isDryRun = false;

  const command = rawArgv[0];
  if (!command || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  // Parse global flags for context/config/calibrate
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

  // Only resolve target if command is target-aware or context/config/calibrate
  const isLocalConfigInit = command === "config" && rawArgv[1] === "init";
  if ((["context", "config", "calibrate"].includes(command) && !isLocalConfigInit) || flagContext || flagServer) {
    try {
      resolvedTarget = await resolveTarget({ context: flagContext, server: flagServer });
    } catch (err: any) {
      handleError(err, { target: resolvedTarget, isJson, isVerbose });
      return;
    }
  }

  const adapter = createTargetAdapter(resolvedTarget, { allowInsecure });
  const subCommand = rawArgv[1] ?? "";
  const commandArgs = rawArgv.slice(2);

  try {
    switch (command) {
      case "context":
        await handleContextCommand(subCommand, commandArgs, { target: resolvedTarget, isJson });
        break;
      case "config":
        await handleConfigCommand(adapter, subCommand, commandArgs, { target: resolvedTarget, isJson, dryRun: isDryRun });
        break;
      case "calibrate":
        await handleCalibrateCommand(adapter, subCommand, rawArgv.slice(1), { target: resolvedTarget, isJson });
        break;
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
        await runProject(subCommand, commandArgs, { isJson, dryRun: isDryRun });
        break;
      case "target":
        await runTarget(subCommand, commandArgs, { isJson, dryRun: isDryRun });
        break;
      case "report":
        await runReport(rawArgv.slice(1));
        break;
      case "scan":
        await runScan(rawArgv.slice(1));
        break;
      case "install":
        await runInstall(rawArgv.slice(1));
        break;
      case "eval":
        await runEval();
        break;
      case "doctor":
        await runDoctor();
        break;
      case "which":
        await runWhich(rawArgv.slice(1));
        break;
      case "manifest":
        await runManifest(subCommand, commandArgs);
        break;
      case "local-vault":
        if (subCommand !== "init") throw new Error("usage: skillmux local-vault init <path>");
        await runLocalVaultInit(commandArgs);
        break;
      case "models":
        if (subCommand !== "download") throw new Error("usage: skillmux models download");
        await runModelDownload();
        break;
      default: {
        const suggestion = suggestCorrection(command, KNOWN_COMMANDS);
        const msg = suggestion
          ? `Unknown command "${command}". Did you mean "${suggestion}"?`
          : `usage: skillmux <serve|index|sync|init|project|target|report|scan|install|eval|doctor|which|manifest pin/unpin|local-vault init|config show|models download|calibrate generate-dataset>`;
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
  ctx: { target: ResolvedTarget; isJson: boolean }
) {
  if (sub === "list") {
    const contexts = await listContexts();
    if (ctx.isJson) {
      console.log(JSON.stringify(formatJsonEnvelope({ ok: true, target: ctx.target, data: contexts })));
    } else {
      renderTargetBanner(ctx.target);
      renderTable(
        [
          { key: "name", header: "NAME" },
          { key: "server", header: "SERVER" },
          { key: "token_env", header: "TOKEN_ENV" },
          { key: "isDefault", header: "DEFAULT" },
        ],
        contexts.map((c) => ({ ...c, token_env: c.token_env ?? "-", isDefault: c.isDefault ? "*" : "" }))
      );
    }
    return;
  }

  if (sub === "current") {
    const current = await getCurrentContext();
    if (ctx.isJson) {
      console.log(JSON.stringify(formatJsonEnvelope({ ok: true, target: ctx.target, data: current })));
    } else {
      renderTargetBanner(ctx.target);
      console.log(`Current context: ${current.name} (${current.server})`);
    }
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
      throw new Error("usage: skillmux context add <name> --server <url> [--token-env <env_name>]");
    }
    await addContext(name, { server, token_env: tokenEnv });
    if (ctx.isJson) {
      console.log(JSON.stringify(formatJsonEnvelope({ ok: true, target: ctx.target, data: { name, server, token_env: tokenEnv } })));
    } else {
      console.log(`Added context "${name}" -> ${server}`);
    }
    return;
  }

  if (sub === "use") {
    const name = args[0];
    if (!name) throw new Error("usage: skillmux context use <name>");
    await useContext(name);
    if (ctx.isJson) {
      console.log(JSON.stringify(formatJsonEnvelope({ ok: true, target: ctx.target, data: { default_context: name } })));
    } else {
      console.log(`Switched default context to "${name}"`);
    }
    return;
  }

  if (sub === "remove") {
    const name = args[0];
    if (!name) throw new Error("usage: skillmux context remove <name>");
    await removeContext(name);
    if (ctx.isJson) {
      console.log(JSON.stringify(formatJsonEnvelope({ ok: true, target: ctx.target, data: { removed: name } })));
    } else {
      console.log(`Removed context "${name}"`);
    }
    return;
  }

  throw new Error("usage: skillmux context <add|list|current|use|remove>");
}

async function handleConfigCommand(
  adapter: TargetAdapter,
  sub: string,
  args: string[],
  ctx: { target: ResolvedTarget; isJson: boolean; dryRun: boolean }
) {
  if (sub === "init") {
    let vaultPath: string | undefined;
    let yes = false;
    for (let i = 0; i < args.length; i++) {
      const option = args[i];
      if (option === "--vault") {
        vaultPath = args[++i];
        if (!vaultPath) throw new Error("usage: skillmux config init --vault <path> --yes");
      } else if (option === "--yes") {
        yes = true;
      } else if (option === "--dry-run" || option === "--json") {
        continue;
      } else {
        throw new Error(`unknown config init option: ${option}`);
      }
    }
    if (!vaultPath) {
      if (isInteractive() && !ctx.isJson) {
        vaultPath = "~/skills";
      } else {
        throw new Error("usage: skillmux config init --vault <path> --yes");
      }
    }

    migrateLegacyPaths();
    const plan = planConfigInit(resolveConfigPath(), expandHome(vaultPath));
    if (plan.action === "preserve") {
      console.log(ctx.isJson
        ? JSON.stringify({
            schema_version: 1,
            ok: true,
            command: "config init",
            phase: "result",
            dry_run: ctx.dryRun,
            applied: false,
            plan: { config_path: plan.configPath, vault_path: plan.vaultPath, action: "preserve" },
          })
        : `preserved existing config: ${plan.configPath}`);
      return;
    }
    if (ctx.dryRun) {
      console.log(ctx.isJson
        ? JSON.stringify({
            schema_version: 1,
            ok: true,
            command: "config init",
            phase: "plan",
            dry_run: true,
            applied: false,
            plan: { config_path: plan.configPath, vault_path: plan.vaultPath, action: "create" },
          })
        : `config create: ${plan.configPath} (dry-run)`);
      return;
    }
    if (!yes) {
      if (!ctx.isJson && isInteractive()) {
        if (!(await confirmAction(`Create ${plan.configPath} with vault_path ${plan.vaultPath}?`))) {
          console.log("config init cancelled; nothing written");
          return;
        }
      } else {
        throw new Error("config initialization requires --yes in noninteractive mode");
      }
    }

    const result = applyConfigInit(plan);
    console.log(ctx.isJson
      ? JSON.stringify({
          schema_version: 1,
          ok: true,
          command: "config init",
          phase: "result",
          dry_run: false,
          applied: result === "created",
          plan: { config_path: plan.configPath, vault_path: plan.vaultPath, action: plan.action },
        })
      : result === "created"
        ? `created ${plan.configPath}`
        : `preserved existing config: ${plan.configPath}`);
    return;
  }

  if (sub === "show") {
    const data = await adapter.getConfigShow();
    if (ctx.isJson) {
      console.log(JSON.stringify(formatJsonEnvelope({ ok: true, target: ctx.target, data })));
    } else {
      renderTargetBanner(ctx.target);
      console.log(JSON.stringify(data.effective, null, 2));
    }
    return;
  }

  if (sub === "get") {
    const key = args[0];
    if (!key) throw new Error("usage: skillmux config get <key>");
    const val = await adapter.getConfigGet(key);
    if (ctx.isJson) {
      console.log(JSON.stringify(formatJsonEnvelope({ ok: true, target: ctx.target, data: { key, value: val } })));
    } else {
      console.log(typeof val === "object" ? JSON.stringify(val) : String(val));
    }
    return;
  }

  if (sub === "validate") {
    const res = await adapter.configValidate();
    if (ctx.isJson) {
      console.log(JSON.stringify(formatJsonEnvelope({ ok: true, target: ctx.target, data: res })));
    } else {
      console.log(res.valid ? "Configuration is valid." : "Configuration is invalid.");
    }
    return;
  }

  if (sub === "diff") {
    const res = await adapter.configDiff();
    if (ctx.isJson) {
      console.log(JSON.stringify(formatJsonEnvelope({ ok: true, target: ctx.target, data: res })));
    } else {
      renderTargetBanner(ctx.target);
      console.log(JSON.stringify(res.diff, null, 2));
    }
    return;
  }

  if (sub === "set") {
    const key = args[0];
    const value = args[1];
    if (!key || value === undefined) {
      throw new Error("usage: skillmux config set <key> <value> [--dry-run]");
    }
    const res = await adapter.configSet(key, value, { dryRun: ctx.dryRun });
    if (ctx.isJson) {
      console.log(JSON.stringify(formatJsonEnvelope({ ok: true, target: ctx.target, data: res })));
    } else {
      renderTargetBanner(ctx.target);
      const prefix = ctx.dryRun ? "[dry-run] " : "";
      console.log(`${prefix}${key}: ${JSON.stringify(res.prior_val)} -> ${JSON.stringify(res.resulting_val)}`);
      console.log(`Persistence: ${res.persistence}, Application: ${res.application}`);
    }
    return;
  }

  if (sub === "status") {
    const res = await adapter.configStatus();
    if (ctx.isJson) {
      console.log(JSON.stringify(formatJsonEnvelope({ ok: true, target: ctx.target, data: res })));
    } else {
      renderTargetBanner(ctx.target);
      console.log(`Runtime: ${res.runtime}`);
      console.log(`Active revision: ${res.active_revision}`);
      console.log(`Readiness: ${res.readiness.status}`);
    }
    return;
  }

  throw new Error("usage: skillmux config show");
}

async function confirmAction(prompt: string): Promise<boolean> {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await readline.question(`${prompt} [y/N] `)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    readline.close();
  }
}

async function handleCalibrateCommand(
  adapter: TargetAdapter,
  sub: string,
  args: string[],
  ctx: { target: ResolvedTarget; isJson: boolean }
) {
  if (sub === "run") {
    let datasetPath: string | undefined;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--dataset") datasetPath = args[++i];
    }
    const res = await adapter.calibrateRun({ datasetPath });
    if (ctx.isJson) {
      console.log(JSON.stringify(formatJsonEnvelope({ ok: true, target: ctx.target, data: res })));
    } else {
      renderTargetBanner(ctx.target);
      console.log(`Calibration run complete.`);
      if (res.result) console.log(JSON.stringify(res.result, null, 2));
    }
    return;
  }

  if (sub === "list") {
    const res = await adapter.calibrateList();
    if (ctx.isJson) {
      console.log(JSON.stringify(formatJsonEnvelope({ ok: true, target: ctx.target, data: res })));
    } else {
      renderTargetBanner(ctx.target);
      renderTable(
        [
          { key: "run_id", header: "RUN_ID" },
          { key: "created_at", header: "CREATED_AT" },
          { key: "status", header: "STATUS" },
        ],
        res
      );
    }
    return;
  }

  if (sub === "show") {
    const runId = args[1];
    if (!runId) throw new Error("usage: skillmux calibrate show <run_id>");
    const res = await adapter.calibrateShow(runId);
    if (ctx.isJson) {
      console.log(JSON.stringify(formatJsonEnvelope({ ok: true, target: ctx.target, data: res })));
    } else {
      renderTargetBanner(ctx.target);
      console.log(JSON.stringify(res, null, 2));
    }
    return;
  }

  if (sub === "apply") {
    const runId = args[1];
    if (!runId) throw new Error("usage: skillmux calibrate apply <run_id>");
    const res = await adapter.calibrateApply(runId);
    if (ctx.isJson) {
      console.log(JSON.stringify(formatJsonEnvelope({ ok: true, target: ctx.target, data: res })));
    } else {
      renderTargetBanner(ctx.target);
      console.log(`Applied calibration run "${runId}"`);
    }
    return;
  }

  if (sub === "generate-dataset") {
    await runCalibrateGenerateDataset(args.slice(1));
    return;
  }

  throw new Error("usage: skillmux calibrate generate-dataset [--vault <path>] [--out <file>]");
}

async function handleCompletionsCommand(shell: string) {
  if (shell !== "bash" && shell !== "zsh" && shell !== "fish") {
    throw new Error("usage: skillmux completions <bash|zsh|fish>");
  }
  console.log(generateCompletions(shell as ShellType));
}

function handleError(
  err: any,
  opts: { target: ResolvedTarget; isJson: boolean; isVerbose: boolean }
) {
  const code = mapExitCode(err);
  process.exitCode = code;

  const msg = err instanceof Error ? err.message : String(err);

  if (opts.isJson) {
    const env = formatJsonEnvelope({
      ok: false,
      target: opts.target,
      error: { code: `EXIT_${code}`, message: msg },
    });
    console.log(JSON.stringify(env));
  } else {
    console.error(msg.startsWith("usage:") || msg.startsWith("Unknown") || msg.startsWith("error:") ? msg : `error: ${msg}`);
    if (opts.isVerbose && err instanceof Error && err.stack) {
      console.error(err.stack);
    }
  }
}

function printHelp(): void {
  console.log(`usage: skillmux <command> [options]

Setup:
  skillmux config init --vault <path> --yes
  skillmux init [--client <name>...] [--target <name>...] [--path <dir>]
                [--vault <path>] [--core <skill_id>...]
                [--migrate-full-vault] [--no-instructions] [--no-sync]
                [--interactive|--yes|--dry-run] [--json]
  skillmux project init [path] [--name <group>] [--skill <skill_id>...]
                [--client <name>...] [--target <name>...] [--no-sync]
                [--interactive|--yes|--dry-run] [--json]
  skillmux project <list|show|add-path|remove-path|pin|unpin|attach|detach>
  skillmux target <list|show|add|remove>

Init clients:
  claude-code, codex, gemini-cli, opencode, github-copilot, windsurf,
  antigravity, goose, hermes, skillmux-mcp

Init targets:
  agent-skills, claude-code, codex, custom

Commands:
  serve, index, sync, init, project, target, report, scan, install, eval, doctor, which,
  manifest, local-vault, config, models, calibrate, context, completions`);
}

// ---------------------------------------------------------------------------
// Implementation of commands: serve, index, sync, init, report, scan, install, eval, doctor, models
// ---------------------------------------------------------------------------

type Transport = "stdio" | "http";

function parseServeArgs(args: string[]): { transport: Transport; port?: number } {
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
    console.error(`warning: keeping previous index entry for ${skillId}: ${error}`);
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
    console.log("embeddings: skipped (endpoint unreachable; lexical-only recall until next index)");
  }
}

async function runEval(): Promise<void> {
  const config = await loadConfig();
  configure({ config, clients: createClients(config) });

  const report = await evalVault().catch((error: unknown) => {
    throw new Error(`eval requires local embeddings: ${String(error)}`);
  });
  console.log(`holdout queries: ${report.queries}`);
  console.log(`lexical recall@3: ${report.lexical.recall_at_3.toFixed(3)}`);
  console.log(`lexical recall@5: ${report.lexical.recall_at_5.toFixed(3)}`);
  console.log(`lexical MRR:      ${report.lexical.mrr.toFixed(3)}`);
  console.log(`hybrid recall@3:  ${report.hybrid.recall_at_3.toFixed(3)}`);
  console.log(`hybrid recall@5:  ${report.hybrid.recall_at_5.toFixed(3)}`);
  console.log(`hybrid MRR:       ${report.hybrid.mrr.toFixed(3)}`);
}

async function runDoctor(): Promise<void> {
  const report = await diagnose(await loadConfig());
  console.log(`inference mode: ${report.mode}`);
  console.log(`routing capability: ${report.capability}`);
  for (const check of report.checks)
    console.log(`${check.ok ? "ok" : "fail"}: ${check.name} - ${check.detail}`);
  if (report.checks.some((check) => !check.ok)) process.exitCode = 1;
}

async function runWhich(args: string[]): Promise<void> {
  const skillId = args[0];
  if (!skillId) throw new Error("usage: skillmux which <skill_id>");
  const config = await loadConfig();
  const vaultPath = expandHome(config.vault_path);
  const localVaultPaths = config.local_vault_paths.map(expandHome);
  const roots = vaultResolutionOrder(vaultPath, localVaultPaths).filter((root) =>
    existsSync(join(root, skillId, "SKILL.md")),
  );
  if (roots.length === 0) {
    console.log(`${skillId}: not found in vault_path or local_vault_paths`);
    process.exitCode = 1;
    return;
  }
  console.log(`${skillId}: serving from ${roots[0]}`);
  for (const shadowedRoot of roots.slice(1)) console.log(`  shadows: ${shadowedRoot}`);
}

const MANIFEST_USAGE = "usage: skillmux manifest <pin|unpin> <skill_id> (--core | --project <group> [--path <path>...])";
const PROJECT_INIT_USAGE =
  "usage: skillmux project init [path] [--name <group>] [--skill <id>...] [--client <id>...] [--target <name>...] [--yes] [--no-sync]";

interface ProjectInitArgs {
  path: string;
  name: string;
  skills: string[];
  clients: string[];
  targets: string[];
  yes: boolean;
  sync: boolean;
}

function configuredTargetForSurface(
  manifest: ReturnType<typeof parseManifest>,
  surface: { targetName: string; path: string },
): string | undefined {
  if (manifest.targets[surface.targetName]) return surface.targetName;
  return Object.entries(manifest.targets).find(
    ([, target]) => expandHome(target.dir) === surface.path,
  )?.[0];
}

function configuredTargetsForClients(
  manifest: ReturnType<typeof parseManifest>,
  clients: readonly string[],
): string[] {
  return planClientSurfaces(clients).surfaces.map((surface) => {
    const target = configuredTargetForSurface(manifest, surface);
    if (target) return target;
    const client = surface.clients[0]!;
    throw new Error(
      `client target for "${client}" is not configured; run "skillmux init --client ${client} --yes" first`,
    );
  });
}

function parseProjectInitArgs(args: string[]): ProjectInitArgs {
  let projectPath: string | undefined;
  let name: string | undefined;
  const skills: string[] = [];
  const clients: string[] = [];
  const targets: string[] = [];
  let yes = false;
  let sync = true;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--name") {
      name = args[++i];
      if (!name) throw new Error("--name requires a group name");
    } else if (arg === "--skill") {
      const skill = args[++i];
      if (!skill) throw new Error("--skill requires a skill_id");
      skills.push(skill);
    } else if (arg === "--target") {
      const target = args[++i];
      if (!target) throw new Error("--target requires a name");
      targets.push(target);
    } else if (arg === "--client") {
      const client = args[++i];
      if (!client) throw new Error("--client requires a name");
      clients.push(client);
    } else if (arg === "--yes") {
      yes = true;
    } else if (arg === "--no-sync") {
      sync = false;
    } else if (arg === "--dry-run" || arg === "--json" || arg === "--interactive") {
      continue;
    } else if (arg.startsWith("-")) {
      throw new Error(`unknown project init option: ${arg}`);
    } else if (projectPath) {
      throw new Error(PROJECT_INIT_USAGE);
    } else {
      projectPath = arg;
    }
  }

  const path = resolveProjectDirectory(projectPath ? expandHome(projectPath) : undefined);
  return { path, name: name ?? suggestProjectName(basename(path)), skills, clients, targets, yes, sync };
}

async function runProject(
  subCommand: string,
  args: string[],
  options: { isJson: boolean; dryRun: boolean },
): Promise<void> {
  if (subCommand === "list" || subCommand === "show") {
    const config = await loadConfig();
    const vaultPath = expandHome(config.vault_path);
    const manifestPath = resolveManifestPath(vaultPath);
    if (!manifestPath) throw new Error(`no skillmux.toml found at ${vaultPath}; run skillmux init first`);
    const manifest = parseManifest(await Bun.file(manifestPath).text());
    const names = subCommand === "show"
      ? [args[0] ?? ""]
      : Object.keys(manifest.project ?? {});
    if (subCommand === "show" && !manifest.project?.[names[0]!]) {
      throw new Error(`[project.${names[0]}] does not exist`);
    }
    const projects = names.map((name) => ({
      name,
      paths: manifest.project?.[name]!.paths ?? [],
      skills: manifest.project?.[name]!.skills ?? [],
      targets: Object.entries(manifest.targets)
        .filter(([, target]) => target.project_groups.includes(name))
        .map(([target]) => target),
    }));
    if (options.isJson) {
      console.log(JSON.stringify({ schema_version: 1, projects }));
    } else if (projects.length === 0) {
      console.log("no project groups configured");
    } else {
      for (const project of projects) {
        console.log(`${project.name}:`);
        console.log(`  paths: ${project.paths.join(", ") || "(none)"}`);
        console.log(`  skills: ${project.skills.join(", ") || "(none)"}`);
        console.log(`  targets: ${project.targets.join(", ") || "(none)"}`);
      }
    }
    return;
  }
  if (subCommand === "add-path" || subCommand === "remove-path") {
    const group = args[0];
    if (!group) throw new Error(`usage: skillmux project ${subCommand} <group> [path] --yes`);
    const rawPath = args[1]?.startsWith("-") ? undefined : args[1];
    const projectPath = resolveProjectDirectory(rawPath ? expandHome(rawPath) : undefined);
    const yes = args.includes("--yes");
    if (!existsSync(projectPath) || !lstatSync(projectPath).isDirectory()) {
      throw new Error(`project path is not a directory: ${projectPath}`);
    }
    const config = await loadConfig();
    const vaultPath = expandHome(config.vault_path);
    const manifestPath = resolveManifestPath(vaultPath);
    if (!manifestPath) throw new Error(`no skillmux.toml found at ${vaultPath}; run skillmux init first`);
    const manifest = parseManifest(await Bun.file(manifestPath).text());
    const updated = updateProjectPaths(manifest, group, {
      ...(subCommand === "add-path" ? { add: [projectPath] } : { remove: [projectPath] }),
    });
    validateManifest(updated, vaultPath, config.local_vault_paths.map(expandHome));
    if (options.dryRun) {
      console.log(`${subCommand}: [project.${group}] ${projectPath} (dry-run)`);
      return;
    }
    if (!yes) {
      if (!options.isJson && isInteractive()) {
        if (!(await confirmAction(`${subCommand} ${projectPath} in [project.${group}]?`))) return;
      } else {
        throw new Error(`skillmux project ${subCommand} requires --yes when run non-interactively`);
      }
    }
    writeManifestAtomic(manifestPath, updated);
    console.log(`${subCommand}: [project.${group}] ${projectPath}`);
    return;
  }
  if (subCommand === "pin" || subCommand === "unpin") {
    const group = args[0];
    const skills = args.slice(1).filter((arg) => !arg.startsWith("-"));
    if (!group || skills.length === 0) {
      throw new Error(`usage: skillmux project ${subCommand} <group> <skill_id>... --yes`);
    }
    const yes = args.includes("--yes");
    const config = await loadConfig();
    const vaultPath = expandHome(config.vault_path);
    const manifestPath = resolveManifestPath(vaultPath);
    if (!manifestPath) throw new Error(`no skillmux.toml found at ${vaultPath}; run skillmux init first`);
    let updated = parseManifest(await Bun.file(manifestPath).text());
    for (const skill of skills) {
      updated = subCommand === "pin"
        ? pinProject(updated, skill, group)
        : unpinProject(updated, skill, group);
    }
    validateManifest(updated, vaultPath, config.local_vault_paths.map(expandHome));
    if (options.dryRun) {
      console.log(`${subCommand}: [project.${group}] ${skills.join(", ")} (dry-run)`);
      return;
    }
    if (!yes) {
      if (!options.isJson && isInteractive()) {
        if (!(await confirmAction(`${subCommand} ${skills.join(", ")} in [project.${group}]?`))) return;
      } else {
        throw new Error(`skillmux project ${subCommand} requires --yes when run non-interactively`);
      }
    }
    writeManifestAtomic(manifestPath, updated);
    console.log(`${subCommand}: [project.${group}] ${skills.join(", ")}`);
    return;
  }
  if (subCommand === "attach" || subCommand === "detach") {
    const group = args[0];
    if (!group) throw new Error(`usage: skillmux project ${subCommand} <group> (--client <id>... | --target <name>...) --yes`);
    const clients: string[] = [];
    const requestedTargets: string[] = [];
    for (let i = 1; i < args.length; i++) {
      if (args[i] === "--client") {
        const value = args[++i];
        if (!value) throw new Error("--client requires a name");
        clients.push(value);
      } else if (args[i] === "--target") {
        const value = args[++i];
        if (!value) throw new Error("--target requires a name");
        requestedTargets.push(value);
      } else if (args[i] !== "--yes" && args[i] !== "--dry-run" && args[i] !== "--json") {
        throw new Error(`unknown project ${subCommand} option: ${args[i]}`);
      }
    }
    const config = await loadConfig();
    const vaultPath = expandHome(config.vault_path);
    const manifestPath = resolveManifestPath(vaultPath);
    if (!manifestPath) throw new Error(`no skillmux.toml found at ${vaultPath}; run skillmux init first`);
    const manifest = parseManifest(await Bun.file(manifestPath).text());
    const clientTargets = configuredTargetsForClients(manifest, clients);
    const targets = [...new Set([...requestedTargets, ...clientTargets])];
    if (targets.length === 0) {
      throw new Error(`project ${subCommand} requires --client or --target`);
    }
    const updated = updateProjectTargets(manifest, group, {
      ...(subCommand === "attach" ? { attach: targets } : { detach: targets }),
    });
    validateManifest(updated, vaultPath, config.local_vault_paths.map(expandHome));
    if (options.dryRun) {
      console.log(`${subCommand}: [project.${group}] ${targets.join(", ")} (dry-run)`);
      return;
    }
    if (!args.includes("--yes")) {
      if (!options.isJson && isInteractive()) {
        if (!(await confirmAction(`${subCommand} [project.${group}] to ${targets.join(", ")}?`))) return;
      } else {
        throw new Error(`skillmux project ${subCommand} requires --yes when run non-interactively`);
      }
    }
    writeManifestAtomic(manifestPath, updated);
    console.log(`${subCommand}: [project.${group}] ${targets.join(", ")}`);
    return;
  }
  if (subCommand !== "init") throw new Error(PROJECT_INIT_USAGE);
  let request = parseProjectInitArgs(args);
  const guided = shouldUseWizard(args, {
    interactive: isInteractive(),
    json: options.isJson,
    dryRun: options.dryRun,
  });
  if (!existsSync(request.path)) throw new Error(`project path does not exist: ${request.path}`);
  if (!lstatSync(request.path).isDirectory()) {
    throw new Error(`project path is not a directory: ${request.path}`);
  }

  const config = await loadConfig();
  const vaultPath = expandHome(config.vault_path);
  const localVaultPaths = config.local_vault_paths.map(expandHome);
  const manifestPath = resolveManifestPath(vaultPath);
  if (!manifestPath) throw new Error(`no skillmux.toml found at ${vaultPath}; run skillmux init first`);
  const manifest = parseManifest(await Bun.file(manifestPath).text());
  if (guided) {
    const name = await promptText("Project group", request.name);
    const availableClients = SUPPORTED_CLIENT_IDS.filter((client) => {
      const surface = planClientSurfaces([client]).surfaces[0];
      return surface !== undefined && configuredTargetForSurface(manifest, surface) !== undefined;
    });
    const clients = await promptMultiSelect(
      "Which clients should receive project skills?",
      availableClients.map((client) => ({
        value: client,
        label: client,
        selected: request.clients.length === 0 || request.clients.includes(client),
      })),
    );
    const skills = parseCommaList(
      await promptText("Project skill IDs, comma-separated", request.skills.join(",")),
    );
    request = { ...request, name, clients, skills };
  }
  const clientTargets = configuredTargetsForClients(manifest, request.clients);
  const targets = [...new Set([...request.targets, ...clientTargets])];
  const updated = upsertProject(manifest, {
    name: request.name,
    paths: [request.path],
    skills: request.skills,
    targets,
  });
  const { notes } = validateManifest(updated, vaultPath, localVaultPaths);
  const plan = {
    mode: "project",
    project: request.name,
    path: request.path,
    skills: request.skills,
    clients: request.clients,
    targets,
    sync: request.sync,
    notes,
  };

  if (options.dryRun) {
    console.log(options.isJson ? JSON.stringify({ schema_version: 1, plan }) : `project plan: ${JSON.stringify(plan)}`);
    return;
  }
  if (!request.yes) {
    if (!options.isJson && isInteractive()) {
      if (guided) {
        console.log("\nReview");
        console.log(`  project: ${request.name}`);
        console.log(`  path: ${request.path}`);
        console.log(`  clients: ${request.clients.join(", ") || "(none)"}`);
        console.log(`  skills: ${request.skills.join(", ") || "(none)"}`);
        console.log(`  sync: ${request.sync ? "yes" : "no"}`);
      }
      if (!(await confirmAction(`Apply project setup for ${request.name} at ${request.path}?`))) {
        console.log("project setup cancelled");
        return;
      }
    } else {
      throw new Error("skillmux project init requires --yes when run non-interactively");
    }
  }

  writeManifestAtomic(manifestPath, updated);
  if (request.sync) {
    try {
      await runSync([]);
    } catch (error) {
      throw new Error(
        `project configuration was saved, but sync failed; fix the reported issue and run "skillmux sync": ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  if (options.isJson) {
    console.log(JSON.stringify({ schema_version: 1, result: plan }));
  } else {
    console.log(`project "${request.name}" ready at ${request.path}`);
  }
}

async function runTarget(
  subCommand: string,
  args: string[],
  options: { isJson: boolean; dryRun: boolean },
): Promise<void> {
  const config = await loadConfig();
  const vaultPath = expandHome(config.vault_path);
  const manifestPath = resolveManifestPath(vaultPath);
  if (!manifestPath) throw new Error(`no skillmux.toml found at ${vaultPath}; run skillmux init first`);
  const manifest = parseManifest(await Bun.file(manifestPath).text());

  if (subCommand === "list" || subCommand === "show") {
    const names = subCommand === "show" ? [args[0] ?? ""] : Object.keys(manifest.targets);
    if (subCommand === "show" && !manifest.targets[names[0]!]) {
      throw new Error(`target "${names[0]}" does not exist`);
    }
    const targets = names.map((name) => {
      const target = manifest.targets[name]!;
      const clients = SUPPORTED_CLIENT_IDS.filter((client) => {
        const surface = planClientSurfaces([client]).surfaces[0];
        return surface !== undefined && surface.path === expandHome(target.dir);
      });
      return { name, ...target, clients };
    });
    if (options.isJson) {
      console.log(JSON.stringify({ schema_version: 1, targets }));
    } else if (targets.length === 0) {
      console.log("no targets configured");
    } else {
      for (const target of targets) {
        console.log(`${target.name}:`);
        console.log(`  dir: ${target.dir}`);
        console.log(`  host: ${target.host ?? "(global)"}`);
        console.log(`  clients: ${target.clients.join(", ") || "(custom)"}`);
        console.log(`  projects: ${target.project_groups.join(", ") || "(none)"}`);
      }
    }
    return;
  }

  if (subCommand === "add") {
    const name = args[0];
    const pathIndex = args.indexOf("--path");
    const rawPath = pathIndex === -1 ? undefined : args[pathIndex + 1];
    if (!name || !rawPath) throw new Error("usage: skillmux target add <name> --path <dir> --yes");
    const path = expandHome(rawPath);
    if (options.dryRun) {
      const planned = planInitManifest(vaultPath, [{ name, dir: path }], []);
      console.log(options.isJson
        ? JSON.stringify({ schema_version: 1, target: planned.targets[name] })
        : `target add: ${name} -> ${path} (dry-run)`);
      return;
    }
    if (!args.includes("--yes")) {
      if (!options.isJson && isInteractive()) {
        if (!(await confirmAction(`Adopt target ${name} at ${path}?`))) return;
      } else {
        throw new Error("skillmux target add requires --yes when run non-interactively");
      }
    }
    applyInit(vaultPath, [{ name, dir: path }]);
    console.log(`target "${name}" added at ${path}`);
    return;
  }

  if (subCommand === "remove") {
    const name = args[0];
    if (!name || !manifest.targets[name]) {
      throw new Error(name ? `target "${name}" does not exist` : "usage: skillmux target remove <name> --yes");
    }
    if (options.dryRun) {
      console.log(`target remove: ${name} (files preserved, dry-run)`);
      return;
    }
    if (!args.includes("--yes")) {
      if (!options.isJson && isInteractive()) {
        if (!(await confirmAction(`Remove target ${name} from the manifest and preserve its files?`))) return;
      } else {
        throw new Error("skillmux target remove requires --yes when run non-interactively");
      }
    }
    const targets = { ...manifest.targets };
    delete targets[name];
    writeManifestAtomic(manifestPath, { ...manifest, targets });
    console.log(`target "${name}" removed from the manifest; files preserved at ${manifest.targets[name]!.dir}`);
    return;
  }

  throw new Error("usage: skillmux target <list|show|add|remove>");
}

function parseManifestPinArgs(args: string[]): { skillId: string; core: boolean; project?: string; paths: string[] } {
  const skillId = args[0];
  if (!skillId) throw new Error(MANIFEST_USAGE);
  let core = false;
  let project: string | undefined;
  const paths: string[] = [];
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--core") core = true;
    else if (arg === "--project") {
      const value = args[++i];
      if (!value) throw new Error("--project requires a group name");
      project = value;
    } else if (arg === "--path") {
      const value = args[++i];
      if (!value) throw new Error("--path requires a path");
      paths.push(value);
    } else throw new Error(`unknown manifest option: ${arg}`);
  }
  if (core === (project !== undefined)) throw new Error(MANIFEST_USAGE);
  return { skillId, core, project, paths };
}

async function runManifest(subCommand: string, args: string[]): Promise<void> {
  if (subCommand !== "pin" && subCommand !== "unpin") throw new Error(MANIFEST_USAGE);
  const { skillId, core, project, paths } = parseManifestPinArgs(args);
  const config = await loadConfig();
  const vaultPath = expandHome(config.vault_path);
  const localVaultPaths = config.local_vault_paths.map(expandHome);
  const manifestPath = resolveManifestPath(vaultPath);
  if (!manifestPath) throw new Error(`no skillmux.toml found at ${vaultPath}`);
  const manifest = parseManifest(await Bun.file(manifestPath).text());

  let updated;
  if (core) {
    updated = subCommand === "pin" ? pinCore(manifest, skillId) : unpinCore(manifest, skillId);
  } else {
    updated =
      subCommand === "pin"
        ? pinProject(manifest, skillId, project!, paths)
        : unpinProject(manifest, skillId, project!);
  }
  validateManifest(updated, vaultPath, localVaultPaths);
  await Bun.write(manifestPath, serializeManifest(updated));
  console.log(`${subCommand === "pin" ? "pinned" : "unpinned"} "${skillId}" ${core ? "[core]" : `[project.${project}]`}`);
}

async function runLocalVaultInit(args: string[]): Promise<void> {
  const path = args[0];
  if (!path) throw new Error("usage: skillmux local-vault init <path>");
  const expanded = expandHome(path);
  const config = await loadConfig();
  const localVaultPaths = config.local_vault_paths.map(expandHome);
  if (!localVaultPaths.includes(expanded)) {
    throw new Error(`"${path}" is not one of the configured local_vault_paths — add it to config.toml first`);
  }
  if (!existsSync(expanded)) throw new Error(`"${path}" does not exist`);
  writeLocalVaultMarker(expanded, expandHome(config.vault_path));
  console.log(`wrote ${join(expanded, ".skillmux")} (role: local_vault, vault_path: ${expandHome(config.vault_path)})`);
}

async function runModelDownload(): Promise<void> {
  const cacheDir = await downloadLocalModels(await loadConfig());
  console.log(`models ready in ${cacheDir}`);
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
      { vaultPath, targetDir, targetName, coreSkillIds: manifest.core.skills, localVaultPaths },
      { dryRun },
    );
    console.log(`${targetName}: +${result.added.length} -${result.removed.length}${suffix}`);

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
    } else if (option === "--path") {
      const value = args[i + 1];
      if (!value) throw new Error("--path requires a directory");
      customPath = value;
      i++;
    } else if (option === "--core") {
      const value = args[i + 1];
      if (!value) throw new Error("--core requires a skill_id");
      coreSkillIds.push(value);
      i++;
    } else if (option === "--dry-run" || option === "--json" || option === "--interactive") {
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
    const bootstrapVaultPath = requestedVaultPath ??
      (!options.isJson && isInteractive() ? "~/skills" : undefined);
    if (!bootstrapVaultPath) {
      throw new Error(`machine config does not exist: ${configPath}; re-run with --vault <path>`);
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
      codexHome: process.env.CODEX_HOME ? expandHome(process.env.CODEX_HOME) : undefined,
    });
    const evidence = new Map(detected.map((item) => [item.client, item.evidence]));
    selectedClients = await promptMultiSelect(
      "Which clients do you use?",
      SUPPORTED_CLIENT_IDS.map((client) => ({
        value: client,
        label: client,
        detail: evidence.has(client) ? `detected: ${evidence.get(client)}` : undefined,
        selected: evidence.has(client) || requestedClients.includes(client),
      })),
    );
  }
  let selectedCoreSkillIds = coreSkillIds;
  if (guided) {
    selectedCoreSkillIds = parseCommaList(
      await promptText("Core skill IDs to add, comma-separated", coreSkillIds.join(",")),
    );
  }

  const clientPlan = planClientSurfaces(selectedClients, {
    codexHome: process.env.CODEX_HOME ? expandHome(process.env.CODEX_HOME) : undefined,
  });
  const instructionPlan = planInstructionSetup(skipInstructions ? [] : clientPlan.clients.map((client) => client.id), {
    codexHome: process.env.CODEX_HOME ? expandHome(process.env.CODEX_HOME) : undefined,
  });
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
    instructionReadiness[manual.client] = { status: "manual", detail: manual.reason };
  }
  const builtInNames = new Set(["agent-skills", "claude-code", "codex", "custom", "agents", "claude"]);
  const explicitSurfaceTargets = explicitTargets
    .filter((name) => builtInNames.has(name))
    .map((name) =>
      resolveBuiltInTarget(name, {
        codexHome: process.env.CODEX_HOME ? expandHome(process.env.CODEX_HOME) : undefined,
        customPath: customPath ? expandHome(customPath) : undefined,
      }),
    );
  if (customPath && !explicitTargets.includes("custom")) {
    throw new Error("--path may only be used with --target custom");
  }
  for (const target of explicitSurfaceTargets) {
    if (target.warning) console.error(`warning: ${target.warning}`);
  }
  const targetByPath = new Map(
    explicitSurfaceTargets.map((target) => [target.path, target.targetName] as const),
  );
  for (const surface of clientPlan.surfaces) {
    if (!targetByPath.has(surface.path)) targetByPath.set(surface.path, surface.targetName);
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
      const name = targetByPath.get(candidate.path) ?? deriveTargetName(candidate.path);
      if (candidate.state === "missing") {
        console.log(`${name} (${candidate.path}): not found`);
        continue;
      }
      if (candidate.state === "broken-symlink") {
        console.log(`${name} (${candidate.path}): broken symlink`);
        continue;
      }
      if (candidate.state === "full-vault") {
        console.log(`${name} (${candidate.path}): full-vault -> ${candidate.canonicalPath}`);
        continue;
      }
      if (candidate.state === "external-symlink") {
        console.log(`${name} (${candidate.path}): external symlink -> ${candidate.canonicalPath}`);
        continue;
      }
      if (candidate.state === "unsupported") {
        console.log(`${name} (${candidate.path}): unsupported filesystem entry`);
        continue;
      }
      const kind = "real dir";
      const marked = candidate.alreadyMarked ? ", already skillmux-managed" : "";
      console.log(`${name} (${candidate.path}): ${kind}, ${candidate.skillCount} skills${marked}`);
    }
    for (const readiness of assessClientReadiness(clientPlan, instructionReadiness)) {
      console.log(`\n${readiness.client} readiness:`);
      console.log(`  skill surface: ${readiness.skillSurface.status} — ${readiness.skillSurface.detail}`);
      console.log(`  MCP registration: ${readiness.mcpRegistration.status} — ${readiness.mcpRegistration.detail}`);
      console.log(`  instructions: ${readiness.instructionSetup.status} — ${readiness.instructionSetup.detail}`);
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
      .filter((candidate) =>
        candidate.deliveryMode === "managed-pins" ||
        (migrateFullVault && candidate.state === "full-vault"),
      )
      .map((candidate) => [
        targetByPath.get(candidate.path) ?? deriveTargetName(candidate.path),
        candidate,
      ] as const),
  );
  const allCandidatesByName = new Map(
    candidates.map((candidate) => [
      targetByPath.get(candidate.path) ?? deriveTargetName(candidate.path),
      candidate,
    ] as const),
  );
  for (const name of requestedTargets) {
    if (!byName.has(name)) {
      if (allCandidatesByName.get(name)?.state === "full-vault") {
        throw new Error(
          `target "${name}" is a full-vault surface; re-run with --migrate-full-vault to convert it to managed pins`,
        );
      }
      throw new Error(`unknown --target "${name}": not among detected surfaces`);
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
  const plannedManifest = planInitManifest(vaultPath, confirmedTargets, selectedCoreSkillIds);
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
      console.log(JSON.stringify({
        schema_version: 1,
        ok: true,
        command: "init",
        phase: "plan",
        dry_run: options.dryRun,
        applied: false,
        plan: serializedPlan,
      }));
    } else {
      console.log("\nno managed-pins surface selected — nothing written.");
    }
    return;
  }
  if (!options.isJson) {
    for (const target of confirmedTargets.filter((target) => target.migrateFullVault)) {
      console.log(
        `full-vault migration ${target.name}: ${vaultHealth.skillCount} visible skills -> ` +
        `${plannedManifest.core.skills.length} core ${plannedManifest.core.skills.length === 1 ? "skill" : "skills"} after sync`,
      );
    }
  }
  if (options.dryRun) {
    if (options.isJson) {
      console.log(JSON.stringify({
        schema_version: 1,
        ok: true,
        command: "init",
        phase: "plan",
        dry_run: true,
        applied: false,
        plan: serializedPlan,
      }));
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
        console.log(`  core: ${plannedManifest.core.skills.join(", ") || "(none)"}`);
        console.log(`  sync: ${sync ? "yes" : "no"}`);
        if (!(await confirmAction("Apply this setup plan?"))) {
          console.log("init cancelled");
          return;
        }
      } else {
        const prompts = [
          ...confirmedTargets.map((target) => `Adopt ${target.name} at ${target.dir}?`),
          ...instructionPlan.changes
            .filter((change) => change.status !== "unchanged")
            .map((change) => `${change.status} instruction file ${change.path}?`),
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
    console.log(JSON.stringify({
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
    }));
    return;
  }
  if (configCreated) console.log(`created ${configPath}`);
  if (confirmedTargets.length > 0) {
    console.log(`\nwrote ${join(vaultPath, "skillmux.toml")}, adopted: ${confirmedTargets.map((t) => t.name).join(", ")}`);
  } else if (selectedCoreSkillIds.length > 0) {
    console.log(`\nwrote ${join(vaultPath, "skillmux.toml")}`);
  }
  if (plannedManifest.core.skills.length === 0 && confirmedTargets.length > 0) {
    console.log("next: skillmux manifest pin <skill_id> --core");
  }
  if (confirmedTargets.length > 0) console.log("next: skillmux sync");
  if (selectedClients.length === 0 || selectedClients.includes("skillmux-mcp")) {
    console.log(`\n${printLastMile()}`);
  }
  if (guided && sync && confirmedTargets.length > 0) await runSync([]);
}

function parseReportArgs(args: string[]): { server?: string; db?: string; since?: string } {
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
    } else {
      throw new Error(`unknown report option: ${option}`);
    }
  }
  if (server && db) throw new Error("--server and --db are mutually exclusive");
  return { server, db, since };
}

async function runReport(args: string[]): Promise<void> {
  const { server, db: dbPath, since } = parseReportArgs(args);
  if (!since) throw new Error("usage: skillmux report [--server <url> | --db <path>] --since <window>");

  if (server) {
    const url = `${server.replace(/\/$/, "")}/stats?since=${encodeURIComponent(since)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`skillmux report --server failed: ${res.status} ${await res.text()}`);
    console.log(renderStatsText((await res.json()) as StatsResponse));
    return;
  }

  const db = dbPath ? new Database(dbPath, { readonly: true }) : openIndex(expandHome((await loadConfig()).state_dir));
  console.log(renderStatsText(getStats(db, since)));
  db.close();
}

function parseScanArgs(args: string[]): { path?: string; format: "text" | "json"; failOn?: ScanSeverity } {
  let path: string | undefined;
  let format: "text" | "json" = "text";
  let failOn: ScanSeverity | undefined;
  for (let i = 0; i < args.length; i++) {
    const option = args[i];
    if (option === "--format") {
      const value = args[++i];
      if (value !== "text" && value !== "json") throw new Error("--format must be text or json");
      format = value;
    } else if (option === "--fail-on") {
      const value = args[++i];
      if (value !== "low" && value !== "medium" && value !== "high") {
        throw new Error("--fail-on must be low, medium, or high");
      }
      failOn = value;
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

async function runScan(args: string[]): Promise<void> {
  const { path, format, failOn } = parseScanArgs(args);
  const rootPath = path ? expandHome(path) : expandHome((await loadConfig()).vault_path);
  const result = await scanPath(rootPath);
  console.log(format === "json" ? renderScanJson(result) : renderScanText(result));
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

async function runInstall(args: string[]): Promise<void> {
  const { repo, force, dryRun, failOn } = parseInstallArgs(args);
  if (!repo) {
    throw new Error("usage: skillmux install <repo>[/path] [--force] [--fail-on low|medium|high] [--dry-run]");
  }

  const source = resolveRepoSource(repo);
  const cloneDir = await cloneToTemp(source.url);
  try {
    const resolved = resolveSkillDir(cloneDir, deriveRepoName(source.url), source.skillPath);
    const { findings } = await validateSkillCandidate(resolved.skillId, resolved.dir);
    console.log(renderScanText({ scanned: 1, findings }));

    if (scanExitCode(findings, failOn) !== 0) {
      process.exitCode = 1;
      console.error(`aborting install: a finding met the --fail-on ${failOn} threshold`);
      return;
    }

    const vaultPath = expandHome((await loadConfig()).vault_path);
    if (dryRun) {
      console.log(`dry-run: would install "${resolved.skillId}" into ${join(vaultPath, resolved.skillId)}`);
      return;
    }

    const targetDir = installIntoVault(vaultPath, resolved.skillId, resolved.dir, force);
    console.log(`installed "${resolved.skillId}" into ${targetDir}`);
  } finally {
    rmSync(cloneDir, { recursive: true, force: true });
  }
}

function parseCalibrateGenerateDatasetArgs(args: string[]): { vault?: string; out?: string } {
  let vault: string | undefined;
  let out: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const option = args[i];
    if (option === "--vault") {
      const value = args[++i];
      if (!value) throw new Error("--vault requires a path value");
      vault = value;
    } else if (option === "--out") {
      const value = args[++i];
      if (!value) throw new Error("--out requires a file path value");
      out = value;
    } else {
      throw new Error(`unknown calibrate option: ${option}`);
    }
  }
  return { vault, out };
}

async function runCalibrateGenerateDataset(args: string[]): Promise<void> {
  const { vault: vaultArg, out: outArg } = parseCalibrateGenerateDatasetArgs(args);
  const config = await loadConfig();
  const vaultPath = expandHome(vaultArg ?? config.vault_path);
  const outPath = expandHome(outArg ?? join(config.state_dir, "queries.json"));

  const skills = await scanVault(vaultPath);
  const dataset = generateDataset(skills);

  const parentDir = join(outPath, "..");
  mkdirSync(parentDir, { recursive: true });
  await Bun.write(outPath, JSON.stringify(dataset, null, 2) + "\n");
  console.log(`generated synthetic dataset with ${dataset.length} cases at ${outPath}`);
}

if (import.meta.main) {
  await main();
}
