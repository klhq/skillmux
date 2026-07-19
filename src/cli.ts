#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createClients } from "./clients";
import { loadConfig } from "./config";
import { expandHome } from "./config";
import { openIndex } from "./db";
import { diagnose } from "./doctor";
import { evalVault } from "./eval";
import { applyInit, deriveTargetName, detectSurfaces, printLastMile, surfaceCandidates } from "./init";
import {
  cloneToTemp,
  deriveRepoName,
  installIntoVault,
  resolveRepoSource,
  resolveSkillDir,
  validateSkillCandidate,
} from "./install";
import { parseManifest, validateManifest } from "./manifest";
import { downloadLocalModels } from "./models";
import { backfillEmbeddings, configure, rebuildIndex } from "./router-core";
import { renderScanJson, renderScanText, scanExitCode, scanPath, type ScanSeverity } from "./scan";
import { getStats, renderStatsText, type StatsResponse } from "./stats";
import {
  installPostMergeHook,
  restoreMonolith as restoreMonolithTarget,
  syncProjectTargets,
  syncTarget,
} from "./sync";
import { scanVault } from "./vault";

const [command] = Bun.argv.slice(2);
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
        console.log(
            `${check.ok ? "ok" : "fail"}: ${check.name} - ${check.detail}`,
        );
    if (report.checks.some((check) => !check.ok)) process.exitCode = 1;
}

async function showConfig(): Promise<void> {
    const config = await loadConfig();
    const inference =
        config.inference.mode === "local"
            ? {
                  ...config.inference,
                  models_dir: expandHome(config.inference.models_dir),
              }
            : config.inference;
    console.log(
        JSON.stringify(
            {
                ...config,
                vault_path: expandHome(config.vault_path),
                state_dir: expandHome(config.state_dir),
                inference,
            },
            null,
            2,
        ),
    );
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

    const manifestPath = join(vaultPath, "skr.toml");
    if (!existsSync(manifestPath)) {
        console.log("no skr.toml found at vault root — nothing to sync");
        return;
    }

    const manifest = parseManifest(await Bun.file(manifestPath).text());
    const vaultSkillIds = new Set(
        (await scanVault(vaultPath)).map((skill) => skill.skill_id),
    );
    const { notes } = validateManifest(manifest, vaultSkillIds);
    for (const note of notes) console.log(`note: ${note}`);

    for (const [targetName, target] of Object.entries(manifest.targets)) {
        const targetDir = expandHome(target.dir);

        if (restoreMonolith) {
            const result = restoreMonolithTarget(targetDir, vaultPath);
            console.log(
                result.restored
                    ? `${targetName}: restored to a vault symlink`
                    : `${targetName}: not owned by skr, left untouched`,
            );
            continue;
        }

        const suffix = dryRun ? " (dry-run)" : "";
        const result = syncTarget(
            { vaultPath, targetDir, targetName, coreSkillIds: manifest.core.skills },
            { dryRun },
        );
        console.log(`${targetName}: +${result.added.length} -${result.removed.length}${suffix}`);

        if (target.project) {
            const projectResults = syncProjectTargets(
                { vaultPath, targetDir, targetName, projectGroups: manifest.project ?? {} },
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

function parseInitArgs(args: string[]): { targets: string[]; yes: boolean } {
    const targets: string[] = [];
    let yes = false;
    for (let i = 0; i < args.length; i++) {
        const option = args[i];
        if (option === "--target") {
            const value = args[i + 1];
            if (!value) throw new Error("--target requires a name");
            targets.push(value);
            i++;
        } else if (option === "--yes") {
            yes = true;
        } else {
            throw new Error(`unknown init option: ${option}`);
        }
    }
    return { targets, yes };
}

async function runInit(args: string[]): Promise<void> {
    const { targets: requestedTargets, yes } = parseInitArgs(args);
    const config = await loadConfig();
    const vaultPath = expandHome(config.vault_path);

    const candidates = detectSurfaces(surfaceCandidates().map(expandHome));
    for (const candidate of candidates) {
        const name = deriveTargetName(candidate.path);
        if (!candidate.exists) {
            console.log(`${name} (${candidate.path}): not found`);
            continue;
        }
        const kind = candidate.isSymlink ? "symlink" : "real dir";
        const marked = candidate.alreadyMarked ? ", already skr-managed" : "";
        console.log(`${name} (${candidate.path}): ${kind}, ${candidate.skillCount} skills${marked}`);
    }

    if (requestedTargets.length === 0) {
        console.log("\nno --target specified — nothing written. Re-run with --target <name> --yes to adopt a surface.");
        return;
    }

    if (!yes) {
        throw new Error(
            "usage: skr init --target <name> [--target <name>...] --yes (interactive per-target confirm is not available non-interactively)",
        );
    }

    const byName = new Map(
        candidates.filter((c) => c.exists).map((c) => [deriveTargetName(c.path), c] as const),
    );
    for (const name of requestedTargets) {
        if (!byName.has(name)) throw new Error(`unknown --target "${name}": not among detected surfaces`);
    }

    const confirmedTargets = requestedTargets.map((name) => ({ name, dir: byName.get(name)!.path }));
    applyInit(vaultPath, confirmedTargets);

    console.log(`\nwrote ${join(vaultPath, "skr.toml")}, adopted: ${confirmedTargets.map((t) => t.name).join(", ")}`);
    console.log(`run "skr sync" next to materialize [core] skills into these targets.\n`);
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
    if (!since) throw new Error("usage: skr report [--server <url> | --db <path>] --since <window>");

    if (server) {
        const url = `${server.replace(/\/$/, "")}/stats?since=${encodeURIComponent(since)}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`skr report --server failed: ${res.status} ${await res.text()}`);
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
            throw new Error("skr scan accepts at most one <path> argument");
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
            throw new Error("skr install accepts at most one <repo> argument");
        } else {
            repo = option;
        }
    }
    return { repo, force, dryRun, failOn };
}

async function runInstall(args: string[]): Promise<void> {
    const { repo, force, dryRun, failOn } = parseInstallArgs(args);
    if (!repo) {
        throw new Error("usage: skr install <repo>[/path] [--force] [--fail-on low|medium|high] [--dry-run]");
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

switch (command) {
    case "serve": {
        const { startServer } = await import("./server");
        const { transport, port } = parseServeArgs(Bun.argv.slice(3));
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
        break;
    }
    case "index":
        await runIndex();
        break;
    case "sync":
        await runSync(Bun.argv.slice(3));
        break;
    case "init":
        await runInit(Bun.argv.slice(3));
        break;
    case "report":
        await runReport(Bun.argv.slice(3));
        break;
    case "scan":
        await runScan(Bun.argv.slice(3));
        break;
    case "install":
        await runInstall(Bun.argv.slice(3));
        break;
    case "eval":
        await runEval();
        break;
    case "doctor":
        await runDoctor();
        break;
    case "config":
        if (Bun.argv[3] !== "show")
            throw new Error("usage: skr config show");
        await showConfig();
        break;
    case "models":
        if (Bun.argv[3] !== "download")
            throw new Error("usage: skr models download");
        await runModelDownload();
        break;
    default:
        console.error(
            "usage: skr <serve|index|sync|init|report|scan|install|eval|doctor|config show|models download> [--transport stdio|http] [--port N] [--dry-run|--restore-monolith|--install-hook] [--target name --yes] [--server url|--db path] --since window [<path>] [--format text|json] [--fail-on low|medium|high] [<repo>[/path] [--force]]",
        );
        process.exit(2);
}
