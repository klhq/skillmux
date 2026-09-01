import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { expandHome, loadConfig } from "../config";
import {
  parseManifest,
  resolveManifestPath,
  validateManifest,
} from "../manifest";
import { emitSuccess, isInteractive, warn } from "../output";
import {
  installPostMergeHook,
  resolveProjectPinDir,
  restoreMonolith as restoreMonolithTarget,
  syncProjectTargets,
  syncTarget,
  type ProjectGroupInput,
} from "../sync";
import { confirmAction } from "./shared";

function parseSyncArgs(args: string[]): {
  dryRun: boolean;
  restoreMonolith: boolean;
  installHook: boolean;
  yes: boolean;
  isJson: boolean;
} {
  let dryRun = false;
  let restoreMonolith = false;
  let installHook = false;
  let yes = false;
  let isJson = false;
  for (const arg of args) {
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--restore-monolith") restoreMonolith = true;
    else if (arg === "--install-hook") installHook = true;
    else if (arg === "--yes") yes = true;
    else if (arg === "--json") isJson = true;
    else throw new Error(`unknown sync option: ${arg}`);
  }
  return { dryRun, restoreMonolith, installHook, yes, isJson };
}

/**
 * A target directory that doesn't exist yet is about to be created by `sync`.
 * `manifest.targets[*].dir` is vault content — readable and writable by whatever
 * populated the vault (a shared git-backed vault pulled in, or a hand-edit) — and
 * `sync` can run unattended via the `--install-hook` post-merge hook. Without this
 * gate, a tampered manifest naming a brand-new path gets that directory silently
 * created (and populated with symlinks) the next time anyone pulls. Creation for
 * an as-yet-unseen directory therefore requires either `--yes` or an interactive
 * confirmation; once the directory exists, later syncs never hit this path again.
 */
async function confirmNewSyncTarget(
  label: string,
  dir: string,
  yes: boolean,
  isJson: boolean,
): Promise<boolean> {
  if (yes) return true;
  if (!isInteractive()) {
    if (!isJson) {
      console.log(
        `${label}: skipped — ${dir} does not exist yet; creating it requires approval. Re-run "skillmux sync --yes", or run "skillmux sync" interactively, once you've confirmed this target is expected.`,
      );
    }
    return false;
  }
  return confirmAction(`${label}: create new target directory ${dir}?`);
}

interface SyncTargetSummary {
  target: string;
  status:
    | "synced"
    | "skipped_host_mismatch"
    | "restored"
    | "not_owned"
    | "skipped_not_approved";
  added?: string[];
  removed?: string[];
  skipped?: string[];
  projects?: {
    group: string;
    pin_dir: string;
    added: string[];
    removed: string[];
    skipped: string[];
  }[];
}

export async function runSync(args: string[]): Promise<void> {
  const { dryRun, restoreMonolith, installHook, yes, isJson } = parseSyncArgs(args);
  const config = await loadConfig();
  const vaultPath = expandHome(config.vault_path);
  const log = (line: string) => {
    if (!isJson) console.log(line);
  };
  const warnLine = (line: string) => {
    if (!isJson) warn(line);
  };

  let hookInstalled: boolean | undefined;
  if (installHook) {
    const result = installPostMergeHook(vaultPath);
    hookInstalled = result.installed;
    log(result.installed ? "installed post-merge hook" : "post-merge hook already installed");
  }

  const manifestPath = resolveManifestPath(vaultPath);
  if (!manifestPath) {
    emitSuccess({ isJson }, { hook_installed: hookInstalled ?? null, targets: [] }, () =>
      console.log("no skillmux.toml found at vault root — nothing to sync"),
    );
    return;
  }

  const manifest = parseManifest(await Bun.file(manifestPath).text());
  const localVaultPaths = config.local_vault_paths.map(expandHome);
  const { notes } = validateManifest(manifest, vaultPath, localVaultPaths);
  for (const note of notes) log(`note: ${note}`);

  const currentHost = hostname();
  const targetSummaries: SyncTargetSummary[] = [];
  for (const [targetName, target] of Object.entries(manifest.targets)) {
    if (target.host !== undefined && target.host !== currentHost) {
      log(
        `${targetName}: skipped (host ${target.host} does not match current host ${currentHost})`,
      );
      targetSummaries.push({ target: targetName, status: "skipped_host_mismatch" });
      continue;
    }
    const targetDir = expandHome(target.dir);

    if (restoreMonolith) {
      const result = restoreMonolithTarget(targetDir, vaultPath);
      log(
        result.restored
          ? `${targetName}: restored to a vault symlink`
          : `${targetName}: not owned by skillmux, left untouched`,
      );
      targetSummaries.push({
        target: targetName,
        status: result.restored ? "restored" : "not_owned",
      });
      continue;
    }

    if (!dryRun && !existsSync(targetDir)) {
      const approved = await confirmNewSyncTarget(targetName, targetDir, yes, isJson);
      if (!approved) {
        if (isInteractive()) {
          log(`${targetName}: skipped — creating ${targetDir} was not approved`);
        }
        targetSummaries.push({ target: targetName, status: "skipped_not_approved" });
        continue;
      }
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
    log(`${targetName}: +${result.added.length} -${result.removed.length}${suffix}`);
    if (result.skipped.length > 0) {
      warnLine(`refused to sync ${result.skipped.join(", ")} — skill directory contains a symlink`);
    }
    const summary: SyncTargetSummary = {
      target: targetName,
      status: "synced",
      added: result.added,
      removed: result.removed,
      skipped: result.skipped,
    };

    if (target.project_groups.length > 0) {
      const allGroups = manifest.project ?? {};
      const projectGroups: Record<string, ProjectGroupInput> = {};
      for (const groupName of target.project_groups) {
        const group = allGroups[groupName]!;
        const approvedPaths: string[] = [];
        for (const path of group.paths) {
          // Mirror syncProjectTargets' own `if (!existsSync(path)) continue` so we
          // never prompt for a project path it would silently skip anyway.
          if (!existsSync(path)) continue;
          const pinDir = resolveProjectPinDir(targetDir, path);
          if (dryRun || existsSync(pinDir)) {
            approvedPaths.push(path);
            continue;
          }
          const approved = await confirmNewSyncTarget(`${targetName}/${groupName}`, pinDir, yes, isJson);
          if (approved) approvedPaths.push(path);
        }
        projectGroups[groupName] = { ...group, paths: approvedPaths };
      }
      const projectResults = syncProjectTargets(
        { vaultPath, targetDir, targetName, projectGroups, localVaultPaths },
        { dryRun },
      );
      summary.projects = projectResults.map((projectResult) => ({
        group: projectResult.group,
        pin_dir: projectResult.pinDir,
        added: projectResult.added,
        removed: projectResult.removed,
        skipped: projectResult.skipped,
      }));
      for (const projectResult of projectResults) {
        log(
          `  ${projectResult.group} -> ${projectResult.pinDir}: +${projectResult.added.length} -${projectResult.removed.length}${suffix}`,
        );
        if (projectResult.skipped.length > 0) {
          warnLine(
            `refused to sync ${projectResult.skipped.join(", ")} — skill directory contains a symlink`,
          );
        }
      }
    }
    targetSummaries.push(summary);
  }

  emitSuccess(
    { isJson },
    { hook_installed: hookInstalled ?? null, notes, targets: targetSummaries },
    () => {},
  );
}
