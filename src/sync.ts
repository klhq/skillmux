import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { resolveSkillRoot } from "./vault";

export const SKILLMUX_MARKER_FILENAME = ".skillmux";
export const LEGACY_MARKER_FILENAME = ".skr";

export interface SkillmuxMarker {
  managed_by: "skillmux" | "skr";
  target: string;
  created_at: string;
}

export function readSkillmuxMarker(dir: string): SkillmuxMarker | null {
  const newPath = join(dir, SKILLMUX_MARKER_FILENAME);
  if (existsSync(newPath)) {
    return JSON.parse(readFileSync(newPath, "utf-8")) as SkillmuxMarker;
  }
  const legacyPath = join(dir, LEGACY_MARKER_FILENAME);
  if (existsSync(legacyPath)) {
    return JSON.parse(readFileSync(legacyPath, "utf-8")) as SkillmuxMarker;
  }
  return null;
}

function writeSkillmuxMarker(dir: string, targetName: string): void {
  const marker: SkillmuxMarker = {
    managed_by: "skillmux",
    target: targetName,
    created_at: new Date().toISOString(),
  };
  writeFileSync(join(dir, SKILLMUX_MARKER_FILENAME), JSON.stringify(marker, null, 2));
}

export interface SyncTargetParams {
  vaultPath: string;
  targetDir: string;
  targetName: string;
  coreSkillIds: string[];
  localVaultPaths?: string[];
}

export interface SyncTargetResult {
  added: string[];
  removed: string[];
}

export interface SyncTargetOptions {
  dryRun?: boolean;
}

export function syncTarget(params: SyncTargetParams, options: SyncTargetOptions = {}): SyncTargetResult {
  const { vaultPath, targetDir, targetName, coreSkillIds, localVaultPaths = [] } = params;
  const { dryRun = false } = options;
  const skillSource = (skillId: string) => resolveSkillRoot(skillId, vaultPath, localVaultPaths) ?? vaultPath;

  if (!existsSync(targetDir)) {
    if (dryRun) return { added: [...coreSkillIds], removed: [] };
    mkdirSync(targetDir, { recursive: true });
    for (const skillId of coreSkillIds) {
      symlinkSync(join(skillSource(skillId), skillId), join(targetDir, skillId));
    }
    writeSkillmuxMarker(targetDir, targetName);
    return { added: [...coreSkillIds], removed: [] };
  }

  if (!readSkillmuxMarker(targetDir)) {
    throw new Error(`not owned by skillmux — run skillmux init`);
  }

  const desired = new Set(coreSkillIds);
  const existing = readdirSync(targetDir).filter((name) => name !== SKILLMUX_MARKER_FILENAME && name !== LEGACY_MARKER_FILENAME);

  const removed = existing.filter((name) => !desired.has(name));
  const added = coreSkillIds.filter((skillId) => !existing.includes(skillId));
  if (dryRun) return { added, removed };

  for (const name of removed) unlinkSync(join(targetDir, name));
  for (const skillId of added) symlinkSync(join(skillSource(skillId), skillId), join(targetDir, skillId));

  return { added, removed };
}

export interface AdoptTargetResult {
  adopted: boolean;
}

/**
 * Marks an existing directory as skillmux-owned without touching its content —
 * the consented, one-time adoption skillmux init performs (see SkillmuxMarker in
 * schema.json: "the only path allowed to create a .skillmux marker on a
 * previously-unmarked directory"). syncTarget's fresh-dir case handles the
 * "doesn't exist yet" side of that rule; this handles "already exists".
 */
export function adoptTarget(dir: string, targetName: string): AdoptTargetResult {
  if (readSkillmuxMarker(dir)) return { adopted: false };
  writeSkillmuxMarker(dir, targetName);
  return { adopted: true };
}

export interface RestoreMonolithResult {
  restored: boolean;
}

export function restoreMonolith(targetDir: string, vaultPath: string): RestoreMonolithResult {
  if (!readSkillmuxMarker(targetDir)) {
    return { restored: false };
  }
  rmSync(targetDir, { recursive: true, force: true });
  symlinkSync(vaultPath, targetDir);
  return { restored: true };
}

export function resolveProjectPinDir(targetDir: string, repo: string): string {
  const rel = relative(homedir(), targetDir);
  if (rel === "" || rel.startsWith("..")) {
    throw new Error(
      `target dir "${targetDir}" must be inside $HOME to compute a project pin dir (got relative path "${rel}")`,
    );
  }
  return join(repo, rel);
}

export interface ProjectGroupInput {
  repos: string[];
  skills: string[];
}

export interface SyncProjectTargetsParams {
  vaultPath: string;
  targetDir: string;
  targetName: string;
  projectGroups: Record<string, ProjectGroupInput>;
  localVaultPaths?: string[];
}

export interface ProjectPinSyncResult extends SyncTargetResult {
  group: string;
  repo: string;
  pinDir: string;
}

export function syncProjectTargets(
  params: SyncProjectTargetsParams,
  options: SyncTargetOptions = {},
): ProjectPinSyncResult[] {
  const { vaultPath, targetDir, targetName, projectGroups, localVaultPaths = [] } = params;
  const results: ProjectPinSyncResult[] = [];

  for (const [group, projectGroup] of Object.entries(projectGroups)) {
    for (const repo of projectGroup.repos) {
      if (!existsSync(repo)) continue;
      const pinDir = resolveProjectPinDir(targetDir, repo);
      const result = syncTarget(
        { vaultPath, targetDir: pinDir, targetName, coreSkillIds: projectGroup.skills, localVaultPaths },
        options,
      );
      results.push({ group, repo, pinDir, ...result });
    }
  }

  return results;
}

export const HOOK_MARKER = "# managed-by: skillmux sync --install-hook";
export const LEGACY_HOOK_MARKER = "# managed-by: skr sync --install-hook";

export interface InstallHookResult {
  installed: boolean;
}

export function installPostMergeHook(vaultPath: string): InstallHookResult {
  const hookPath = join(vaultPath, ".git", "hooks", "post-merge");

  if (existsSync(hookPath)) {
    const existing = readFileSync(hookPath, "utf-8");
    if (existing.includes(HOOK_MARKER) || existing.includes(LEGACY_HOOK_MARKER)) return { installed: false };
    throw new Error(`${hookPath} already exists and is not managed by skillmux — refusing to overwrite`);
  }

  const script = `#!/bin/sh\n${HOOK_MARKER}\nskillmux sync\n`;
  writeFileSync(hookPath, script);
  chmodSync(hookPath, 0o755);
  return { installed: true };
}
