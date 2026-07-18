#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createClients } from "./clients";
import { loadConfig } from "./config";
import { expandHome } from "./config";
import { diagnose } from "./doctor";
import { evalVault } from "./eval";
import { parseManifest, validateManifest } from "./manifest";
import { downloadLocalModels } from "./models";
import { backfillEmbeddings, configure, rebuildIndex } from "./router-core";
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
            "usage: skr <serve|index|sync|eval|doctor|config show|models download> [--transport stdio|http] [--port N] [--dry-run|--restore-monolith|--install-hook]",
        );
        process.exit(2);
}
