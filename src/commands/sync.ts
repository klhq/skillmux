import { existsSync } from "node:fs";
import { expandHome, loadConfig } from "../config";
import {
  parseManifest,
  resolveManifestPath,
  resolveSyncSurfaces,
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
import type { Config } from "../types";
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
 * A project pin directory that doesn't exist yet is about to be created by
 * `sync`. Its location comes from `[project.*].paths`, which is vault content:
 * readable and writable by whatever populated the vault (a shared git-backed
 * vault pulled in, or a hand-edit), and `sync` can run unattended via the
 * `--install-hook` post-merge hook. Without this gate, a tampered manifest
 * naming a new project path gets directories silently created there on the
 * next pull. Agent directories need no such gate: they are derived from
 * `agents` in this machine's own config.toml, which the vault cannot touch.
 */
async function confirmNewProjectDir(
  label: string,
  dir: string,
  yes: boolean,
  log: (line: string) => void,
): Promise<boolean> {
  if (yes) return true;
  if (!isInteractive()) {
    log(
      `${label}: skipped — ${dir} does not exist yet; creating it requires approval. Re-run "skillmux sync --yes", or run "skillmux sync" interactively, once you've confirmed this project path is expected.`,
    );
    return false;
  }
  return confirmAction(`${label}: create new project skill directory ${dir}?`);
}

interface SyncDirSummary {
  dir: string;
  agents: string[];
  status: "synced" | "restored" | "not_owned";
  added?: string[];
  removed?: string[];
  skipped?: string[];
  renamed_from?: string;
  projects?: {
    group: string;
    pin_dir: string;
    status: "synced" | "skipped_not_approved";
    added: string[];
    removed: string[];
    skipped: string[];
  }[];
}

export interface ExecuteSyncOptions {
  dryRun?: boolean;
  restoreMonolith?: boolean;
  /** Approves creating project pin directories this machine has not synced before. */
  yes?: boolean;
  /** Where per-directory progress lines go. Omit to run silently, as a --json caller must. */
  log?: (line: string) => void;
  warn?: (line: string) => void;
  /** An already-loaded config, so a caller that needed one does not pay for a second read. */
  config?: Config;
}

export interface ExecuteSyncResult {
  manifestFound: boolean;
  notes: string[];
  dirs: SyncDirSummary[];
}

export const NO_AGENTS_NOTE =
  'no agents configured in config.toml, so there is nothing to sync (set agents = [...] or run "skillmux agent add <agent> --yes")';

function label(dir: string, agents: readonly string[]): string {
  return `${dir} (${agents.join(", ")})`;
}

/**
 * Performs the sync and returns what it did, leaving every rendering decision to the
 * caller. `skillmux sync` is one caller. `skillmux core pin` is the other: it needs the
 * summaries as data so it can fold them into its own `--json` envelope instead of
 * emitting a second document.
 */
export async function executeSync(options: ExecuteSyncOptions = {}): Promise<ExecuteSyncResult> {
  const { dryRun = false, restoreMonolith = false, yes = false } = options;
  const log = options.log ?? (() => {});
  const warnLine = options.warn ?? (() => {});
  const config = options.config ?? (await loadConfig());
  const vaultPath = expandHome(config.vault_path);

  const manifestPath = resolveManifestPath(vaultPath);
  if (!manifestPath) return { manifestFound: false, notes: [], dirs: [] };

  const manifest = parseManifest(await Bun.file(manifestPath).text());
  const localVaultPaths = config.local_vault_paths.map(expandHome);
  const { notes } = validateManifest(manifest, vaultPath, localVaultPaths);
  if (config.agents.length === 0) notes.push(NO_AGENTS_NOTE);
  for (const note of notes) log(`note: ${note}`);

  const summaries: SyncDirSummary[] = [];
  for (const surface of resolveSyncSurfaces(manifest, config.agents)) {
    const name = label(surface.dir, surface.agents);

    if (restoreMonolith) {
      const result = restoreMonolithTarget(surface.dir, vaultPath);
      log(result.restored ? `${name}: restored to a vault symlink` : `${name}: not owned by skillmux, left untouched`);
      summaries.push({ dir: surface.dir, agents: surface.agents, status: result.restored ? "restored" : "not_owned" });
      continue;
    }

    const suffix = dryRun ? " (dry-run)" : "";
    const result = syncTarget(
      {
        vaultPath,
        targetDir: surface.dir,
        targetName: surface.id,
        coreSkillIds: manifest.core.skills,
        localVaultPaths,
      },
      { dryRun },
    );
    if (result.renamedFrom !== undefined) {
      log(`${name}: adopted marker from legacy target "${result.renamedFrom}"${suffix}`);
    }
    log(`${name}: +${result.added.length} -${result.removed.length}${suffix}`);
    if (result.skipped.length > 0) {
      warnLine(`refused to sync ${result.skipped.join(", ")} — skill directory contains a symlink`);
    }
    const summary: SyncDirSummary = {
      dir: surface.dir,
      agents: surface.agents,
      status: "synced",
      added: result.added,
      removed: result.removed,
      skipped: result.skipped,
      ...(result.renamedFrom === undefined ? {} : { renamed_from: result.renamedFrom }),
    };

    const groupNames = Object.keys(surface.projectGroups);
    if (groupNames.length > 0) {
      const projectGroups: Record<string, ProjectGroupInput> = {};
      const unapproved: { group: string; pinDir: string }[] = [];
      for (const groupName of groupNames) {
        const group = surface.projectGroups[groupName]!;
        const approvedPaths: string[] = [];
        for (const path of group.paths) {
          // Mirror syncProjectTargets' own `if (!existsSync(path)) continue` so we
          // never prompt for a project path it would silently skip anyway.
          if (!existsSync(path)) continue;
          const pinDir = resolveProjectPinDir(surface.dir, path);
          if (dryRun || existsSync(pinDir)) {
            approvedPaths.push(path);
            continue;
          }
          if (await confirmNewProjectDir(`${groupName} -> ${pinDir}`, pinDir, yes, log)) {
            approvedPaths.push(path);
          } else {
            unapproved.push({ group: groupName, pinDir });
          }
        }
        projectGroups[groupName] = { paths: approvedPaths, skills: group.skills };
      }
      const projectResults = syncProjectTargets(
        { vaultPath, targetDir: surface.dir, targetName: surface.id, projectGroups, localVaultPaths },
        { dryRun },
      );
      summary.projects = [
        ...projectResults.map((projectResult) => ({
          group: projectResult.group,
          pin_dir: projectResult.pinDir,
          status: "synced" as const,
          added: projectResult.added,
          removed: projectResult.removed,
          skipped: projectResult.skipped,
        })),
        ...unapproved.map(({ group, pinDir }) => ({
          group,
          pin_dir: pinDir,
          status: "skipped_not_approved" as const,
          added: [],
          removed: [],
          skipped: [],
        })),
      ];
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
    summaries.push(summary);
  }

  return { manifestFound: true, notes, dirs: summaries };
}

export async function runSync(args: string[]): Promise<void> {
  const { dryRun, restoreMonolith, installHook, yes, isJson } = parseSyncArgs(args);
  const config = await loadConfig();
  const log = isJson ? undefined : (line: string) => console.log(line);

  let hookInstalled: boolean | undefined;
  if (installHook) {
    const result = installPostMergeHook(expandHome(config.vault_path));
    hookInstalled = result.installed;
    log?.(result.installed ? "installed post-merge hook" : "post-merge hook already installed");
  }

  const result = await executeSync({
    dryRun,
    restoreMonolith,
    yes,
    config,
    log,
    warn: isJson ? undefined : (line: string) => warn(line),
  });
  if (!result.manifestFound) {
    emitSuccess({ isJson }, { hook_installed: hookInstalled ?? null, dirs: [] }, () =>
      console.log("no skillmux.toml found at vault root — nothing to sync"),
    );
    return;
  }
  emitSuccess(
    { isJson },
    { hook_installed: hookInstalled ?? null, notes: result.notes, dirs: result.dirs },
    () => {},
  );
}
