#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { generateDataset } from "./dataset-generator";

import { createClients } from "./clients";
import { expandHome, loadConfig, migrateLegacyPaths, resolveConfigPath } from "./config";
import { openIndex } from "./db";
import { diagnose } from "./doctor";
import { evalVault } from "./eval";
import {
  assessClientReadiness,
  planClientSurfaces,
  resolveBuiltInTarget,
  type ClientId,
  type ReadinessAxis,
} from "./init-clients";
import {
  applyInstructionPlan,
  planInstructionSetup,
  rollbackInstructionPlan,
} from "./init-instructions";
import { applyInit, deriveTargetName, detectSurfaces, printLastMile, surfaceCandidates } from "./init";
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
  validateManifest,
} from "./manifest";
import { downloadLocalModels } from "./models";
import { backfillEmbeddings, configure, rebuildIndex } from "./router-core";
import { renderScanJson, renderScanText, scanExitCode, scanPath, type ScanSeverity } from "./scan";
import { applyConfigInit, inspectVault, planConfigInit } from "./setup";
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
        await runInit(rawArgv.slice(1));
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
          : `usage: skillmux <serve|index|sync|init|report|scan|install|eval|doctor|which|manifest pin/unpin|local-vault init|config show|models download|calibrate generate-dataset>`;
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
      } else {
        throw new Error(`unknown config init option: ${option}`);
      }
    }
    if (!vaultPath) throw new Error("usage: skillmux config init --vault <path> --yes");

    migrateLegacyPaths();
    const plan = planConfigInit(resolveConfigPath(), expandHome(vaultPath));
    if (plan.action === "preserve") {
      console.log(`preserved existing config: ${plan.configPath}`);
      return;
    }
    if (!yes) {
      throw new Error("config initialization requires --yes in noninteractive mode");
    }

    const result = applyConfigInit(plan);
    console.log(
      result === "created"
        ? `created ${plan.configPath}`
        : `preserved existing config: ${plan.configPath}`,
    );
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
  console.log(`usage: skillmux <serve|index|sync|init|report|scan|install|eval|doctor|which|manifest pin/unpin|local-vault init|config show|models download|calibrate generate-dataset> [--transport stdio|http] [--port N] [--dry-run|--restore-monolith|--install-hook] [--target name --yes] [--server url|--db path] --since window [<path>] [--format text|json] [--fail-on low|medium|high] [<repo>[/path] [--force]] [--vault path] [--out file]`);
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
  customPath?: string;
  vaultPath?: string;
  yes: boolean;
} {
  const targets: string[] = [];
  const clients: string[] = [];
  let customPath: string | undefined;
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
    } else if (option === "--yes") {
      yes = true;
    } else {
      throw new Error(`unknown init option: ${option}`);
    }
  }
  return { targets, clients, customPath, vaultPath, yes };
}

async function runInit(args: string[]): Promise<void> {
  const {
    targets: explicitTargets,
    clients: requestedClients,
    customPath,
    vaultPath: requestedVaultPath,
    yes,
  } = parseInitArgs(args);
  migrateLegacyPaths();
  const configPath = resolveConfigPath();
  if (!existsSync(configPath)) {
    if (!requestedVaultPath) {
      throw new Error(`machine config does not exist: ${configPath}; re-run with --vault <path>`);
    }
    const configPlan = planConfigInit(configPath, expandHome(requestedVaultPath));
    if (!yes) {
      throw new Error("machine config initialization requires --yes in noninteractive mode");
    }
    if (applyConfigInit(configPlan) === "created") {
      console.log(`created ${configPath}`);
    }
  }

  const config = await loadConfig();
  const vaultPath = expandHome(config.vault_path);
  const vaultHealth = inspectVault(vaultPath);
  if (!vaultHealth.ok) {
    throw new Error(vaultHealth.message);
  }

  const clientPlan = planClientSurfaces(requestedClients, {
    codexHome: process.env.CODEX_HOME ? expandHome(process.env.CODEX_HOME) : undefined,
  });
  const instructionPlan = planInstructionSetup(clientPlan.clients.map((client) => client.id), {
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

  const requestedTargets = [
    ...new Set([
      ...explicitTargets.filter((name) => !builtInNames.has(name)),
      ...targetByPath.values(),
    ]),
  ];
  const hasInstructionWrites = instructionPlan.changes.some(
    (change) => change.status !== "unchanged",
  );
  if (requestedTargets.length === 0 && !hasInstructionWrites) {
    console.log("\nno managed-pins surface selected — nothing written.");
    return;
  }

  if (!yes) {
    throw new Error(
      "skillmux init requires --yes before applying target or instruction changes non-interactively",
    );
  }

  const byName = new Map(
    candidates
      .filter((candidate) => candidate.deliveryMode === "managed-pins")
      .map((candidate) => [
        targetByPath.get(candidate.path) ?? deriveTargetName(candidate.path),
        candidate,
      ] as const),
  );
  for (const name of requestedTargets) {
    if (!byName.has(name)) throw new Error(`unknown --target "${name}": not among detected surfaces`);
  }

  const confirmedTargets = requestedTargets.map((name) => ({ name, dir: byName.get(name)!.path }));
  if (confirmedTargets.length === 0) {
    applyInstructionPlan(instructionPlan);
  } else {
    applyInit(
      vaultPath,
      confirmedTargets,
      hasInstructionWrites
        ? {
            apply: () => applyInstructionPlan(instructionPlan),
            rollback: () => rollbackInstructionPlan(instructionPlan),
          }
        : undefined,
    );
  }

  if (confirmedTargets.length > 0) {
    console.log(`\nwrote ${join(vaultPath, "skillmux.toml")}, adopted: ${confirmedTargets.map((t) => t.name).join(", ")}`);
    console.log(`run "skillmux sync" next to materialize [core] skills into these targets.\n`);
  }
  console.log(printLastMile());
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
