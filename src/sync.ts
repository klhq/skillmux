import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";

export const SKR_MARKER_FILENAME = ".skr";

export interface SkrMarker {
  managed_by: "skr";
  target: string;
  created_at: string;
}

export function readSkrMarker(dir: string): SkrMarker | null {
  const markerPath = join(dir, SKR_MARKER_FILENAME);
  if (!existsSync(markerPath)) return null;
  return JSON.parse(readFileSync(markerPath, "utf-8")) as SkrMarker;
}

function writeSkrMarker(dir: string, targetName: string): void {
  const marker: SkrMarker = {
    managed_by: "skr",
    target: targetName,
    created_at: new Date().toISOString(),
  };
  writeFileSync(join(dir, SKR_MARKER_FILENAME), JSON.stringify(marker, null, 2));
}

export interface SyncTargetParams {
  vaultPath: string;
  targetDir: string;
  targetName: string;
  coreSkillIds: string[];
}

export interface SyncTargetResult {
  added: string[];
  removed: string[];
}

export interface SyncTargetOptions {
  dryRun?: boolean;
}

export function syncTarget(params: SyncTargetParams, options: SyncTargetOptions = {}): SyncTargetResult {
  const { vaultPath, targetDir, targetName, coreSkillIds } = params;
  const { dryRun = false } = options;

  if (!existsSync(targetDir)) {
    if (dryRun) return { added: [...coreSkillIds], removed: [] };
    mkdirSync(targetDir, { recursive: true });
    for (const skillId of coreSkillIds) {
      symlinkSync(join(vaultPath, skillId), join(targetDir, skillId));
    }
    writeSkrMarker(targetDir, targetName);
    return { added: [...coreSkillIds], removed: [] };
  }

  if (!readSkrMarker(targetDir)) {
    throw new Error(`not owned by skr — run skr init`);
  }

  const desired = new Set(coreSkillIds);
  const existing = readdirSync(targetDir).filter((name) => name !== SKR_MARKER_FILENAME);

  const removed = existing.filter((name) => !desired.has(name));
  const added = coreSkillIds.filter((skillId) => !existing.includes(skillId));
  if (dryRun) return { added, removed };

  for (const name of removed) unlinkSync(join(targetDir, name));
  for (const skillId of added) symlinkSync(join(vaultPath, skillId), join(targetDir, skillId));

  return { added, removed };
}

export interface RestoreMonolithResult {
  restored: boolean;
}

export function restoreMonolith(targetDir: string, vaultPath: string): RestoreMonolithResult {
  if (!readSkrMarker(targetDir)) {
    return { restored: false };
  }
  rmSync(targetDir, { recursive: true, force: true });
  symlinkSync(vaultPath, targetDir);
  return { restored: true };
}

export function resolveProjectPinDir(targetDir: string, repo: string): string {
  return join(repo, relative(homedir(), targetDir));
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
  const { vaultPath, targetDir, targetName, projectGroups } = params;
  const results: ProjectPinSyncResult[] = [];

  for (const [group, projectGroup] of Object.entries(projectGroups)) {
    for (const repo of projectGroup.repos) {
      if (!existsSync(repo)) continue;
      const pinDir = resolveProjectPinDir(targetDir, repo);
      const result = syncTarget(
        { vaultPath, targetDir: pinDir, targetName, coreSkillIds: projectGroup.skills },
        options,
      );
      results.push({ group, repo, pinDir, ...result });
    }
  }

  return results;
}
