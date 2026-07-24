import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { resolveSkillRoot } from "./vault";

export const SKILLMUX_MARKER_FILENAME = ".skillmux";
export const LEGACY_MARKER_FILENAME = ".skr";

export interface SkillmuxMarker {
  schema_version?: 1;
  managed_by: "skillmux" | "skr";
  role: "target" | "local_vault";
  target?: string;
  vault_path?: string;
  managed_entries?: string[];
  created_at: string;
}

function normalizeMarker(raw: Omit<SkillmuxMarker, "role"> & { role?: SkillmuxMarker["role"] }): SkillmuxMarker {
  return { ...raw, role: raw.role ?? "target" };
}

function validateMarker(marker: SkillmuxMarker, path: string): SkillmuxMarker {
  if (marker.schema_version === undefined) return marker;
  if (marker.schema_version !== 1) throw new Error(`${path}: unsupported marker schema_version`);
  if (marker.managed_by !== "skillmux") throw new Error(`${path}: invalid managed_by`);
  if (marker.role !== "target" && marker.role !== "local_vault") {
    throw new Error(`${path}: invalid role`);
  }
  if (marker.role === "target") {
    if (typeof marker.target !== "string" || marker.target.length === 0) {
      throw new Error(`${path}: target marker is missing target`);
    }
    if (typeof marker.vault_path !== "string" || marker.vault_path.length === 0) {
      throw new Error(`${path}: target marker is missing vault_path`);
    }
    if (!Array.isArray(marker.managed_entries) || marker.managed_entries.some((entry) => typeof entry !== "string")) {
      throw new Error(`${path}: target marker is missing managed_entries`);
    }
  } else if (typeof marker.vault_path !== "string" || marker.vault_path.length === 0) {
    throw new Error(`${path}: local_vault marker is missing vault_path`);
  }
  if (typeof marker.created_at !== "string") throw new Error(`${path}: marker is missing created_at`);
  return marker;
}

export function readSkillmuxMarker(dir: string): SkillmuxMarker | null {
  const newPath = join(dir, SKILLMUX_MARKER_FILENAME);
  if (existsSync(newPath)) {
    return validateMarker(normalizeMarker(JSON.parse(readFileSync(newPath, "utf-8"))), newPath);
  }
  const legacyPath = join(dir, LEGACY_MARKER_FILENAME);
  if (existsSync(legacyPath)) {
    return validateMarker(normalizeMarker(JSON.parse(readFileSync(legacyPath, "utf-8"))), legacyPath);
  }
  return null;
}

function writeTargetMarker(
  dir: string,
  targetName: string,
  vaultPath: string,
  managedEntries: string[],
  createdAt = new Date().toISOString(),
): void {
  const marker: SkillmuxMarker = {
    schema_version: 1,
    managed_by: "skillmux",
    role: "target",
    target: targetName,
    vault_path: vaultPath,
    managed_entries: managedEntries,
    created_at: createdAt,
  };
  const markerPath = join(dir, SKILLMUX_MARKER_FILENAME);
  const serialized = JSON.stringify(marker, null, 2);
  if (!existsSync(markerPath) || readFileSync(markerPath, "utf-8") !== serialized) {
    writeFileSync(markerPath, serialized);
  }
}

export function writeLocalVaultMarker(dir: string, vaultPath: string): void {
  const marker: SkillmuxMarker = {
    schema_version: 1,
    managed_by: "skillmux",
    role: "local_vault",
    vault_path: vaultPath,
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
    writeTargetMarker(targetDir, targetName, vaultPath, coreSkillIds);
    return { added: [...coreSkillIds], removed: [] };
  }

  let marker = readSkillmuxMarker(targetDir);
  if (!marker) {
    throw new Error(`not owned by skillmux — run skillmux init`);
  }
  if (marker.role === "local_vault") {
    throw new Error(`${targetDir} has a local_vault marker, not target ownership`);
  }
  if (marker.target !== targetName) {
    throw new Error(`${targetDir} is owned by target "${marker.target}", not "${targetName}"`);
  }
  if (marker.schema_version === undefined) {
    const legacyEntries = readdirSync(targetDir).filter(
      (name) => name !== SKILLMUX_MARKER_FILENAME && name !== LEGACY_MARKER_FILENAME,
    );
    if (legacyEntries.length > 0) {
      throw new Error(
        `${targetDir} has a legacy marker with untracked entries; remove or migrate them before running skillmux sync`,
      );
    }
    marker = {
      schema_version: 1,
      managed_by: "skillmux",
      role: "target",
      target: targetName,
      vault_path: vaultPath,
      managed_entries: [],
      created_at: marker.created_at,
    };
    if (!dryRun) writeTargetMarker(targetDir, targetName, vaultPath, [], marker.created_at);
  }
  if (marker.vault_path !== vaultPath) {
    throw new Error(
      `${targetDir} marker recorded vault_path ${marker.vault_path}, currently configured vault_path is ${vaultPath}`,
    );
  }

  const desired = new Set(coreSkillIds);
  const existing = readdirSync(targetDir).filter((name) => name !== SKILLMUX_MARKER_FILENAME && name !== LEGACY_MARKER_FILENAME);
  const managedEntries = new Set(marker.managed_entries ?? []);
  const collisions = coreSkillIds.filter((skillId) => existing.includes(skillId) && !managedEntries.has(skillId));
  if (collisions.length > 0) {
    throw new Error(`unmanaged entry collisions in ${targetDir}: ${collisions.join(", ")}`);
  }

  const removed = [...managedEntries].filter((name) => existing.includes(name) && !desired.has(name));
  const added = coreSkillIds.filter((skillId) => !existing.includes(skillId));
  if (dryRun) return { added, removed };

  for (const name of removed) unlinkSync(join(targetDir, name));
  for (const skillId of added) symlinkSync(join(skillSource(skillId), skillId), join(targetDir, skillId));
  writeTargetMarker(targetDir, targetName, vaultPath, coreSkillIds, marker.created_at);

  return { added, removed };
}

export interface AdoptTargetResult {
  adopted: boolean;
}

export function preflightAdoptTarget(dir: string, targetName: string, vaultPath: string): void {
  const marker = readSkillmuxMarker(dir);
  if (marker?.role === "local_vault") {
    throw new Error(`${dir} has a local_vault marker, not target ownership`);
  }
  if (!marker) return;
  if (marker.target !== targetName) {
    throw new Error(`${dir} is already owned by target "${marker.target}", not "${targetName}"`);
  }
  if (marker.schema_version !== undefined && marker.vault_path !== vaultPath) {
    throw new Error(
      `${dir} marker recorded vault_path ${marker.vault_path}, currently configured vault_path is ${vaultPath}`,
    );
  }
}

/**
 * Marks an existing directory as skillmux-owned without touching its content —
 * the consented, one-time adoption skillmux init performs (see SkillmuxMarker in
 * schema.json: "the only path allowed to create a .skillmux marker on a
 * previously-unmarked directory"). syncTarget's fresh-dir case handles the
 * "doesn't exist yet" side of that rule; this handles "already exists".
 */
export function adoptTarget(dir: string, targetName: string, vaultPath: string): AdoptTargetResult {
  preflightAdoptTarget(dir, targetName, vaultPath);
  if (readSkillmuxMarker(dir)) return { adopted: false };
  writeTargetMarker(dir, targetName, vaultPath, []);
  return { adopted: true };
}

export interface MigrateMarkerDiff {
  /** On-disk entries not accounted for by the expected pinned set. */
  extra: string[];
  /** Expected pinned entries that are missing from disk. */
  missing: string[];
}

export type MigrateMarkerStatus = "already-migrated" | "would-migrate" | "migrated" | "mismatch";

export interface MigrateMarkerResult {
  status: MigrateMarkerStatus;
  /** On-disk entries (excluding marker files), sorted. Empty for "already-migrated". */
  actual: string[];
  /** Expected pinned entries, sorted. Empty for "already-migrated". */
  expected: string[];
  /** Present only when status is "mismatch". */
  diff?: MigrateMarkerDiff;
  marker?: SkillmuxMarker;
}

export interface MigrateMarkerOptions {
  dryRun?: boolean;
}

/**
 * Upgrades a legacy (pre-schema_version) target marker to schema_version 1,
 * automating the verification a human would otherwise do by hand: `ls` the
 * target dir, eyeball it against the manifest's expected pins, and hand-write
 * a managed_entries list. Refuses (no writes) unless the on-disk contents of
 * targetDir exactly match expectedSkillIds — same safety posture as the
 * legacy-marker-with-untracked-entries throw in syncTarget, just with the
 * diff surfaced instead of requiring manual inspection.
 *
 * expectedSkillIds should be the same core-skill set syncTarget would use to
 * populate this target's own directory (i.e. manifest.core.skills for a
 * top-level target) — project-group skills are synced into separate
 * per-project pin directories (see resolveProjectPinDir) and never land in
 * the target's own directory, so they are intentionally excluded here.
 */
export function migrateLegacyMarker(
  targetDir: string,
  targetName: string,
  vaultPath: string,
  expectedSkillIds: string[],
  options: MigrateMarkerOptions = {},
): MigrateMarkerResult {
  const { dryRun = false } = options;
  const marker = readSkillmuxMarker(targetDir);
  if (!marker) {
    throw new Error(`${targetDir} is not owned by skillmux — run skillmux init`);
  }
  if (marker.role === "local_vault") {
    throw new Error(`${targetDir} has a local_vault marker, not target ownership`);
  }
  if (marker.target !== targetName) {
    throw new Error(`${targetDir} is owned by target "${marker.target}", not "${targetName}"`);
  }
  if (marker.schema_version === 1) {
    return { status: "already-migrated", actual: [], expected: [], marker };
  }

  const actual = readdirSync(targetDir)
    .filter((name) => name !== SKILLMUX_MARKER_FILENAME && name !== LEGACY_MARKER_FILENAME)
    .sort();
  const expected = [...new Set(expectedSkillIds)].sort();
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  const extra = actual.filter((name) => !expectedSet.has(name));
  const missing = expected.filter((name) => !actualSet.has(name));

  if (extra.length > 0 || missing.length > 0) {
    return { status: "mismatch", actual, expected, diff: { extra, missing } };
  }

  if (dryRun) {
    return { status: "would-migrate", actual, expected };
  }

  const createdAt = marker.created_at ?? new Date().toISOString();
  writeTargetMarker(targetDir, targetName, vaultPath, actual, createdAt);
  return { status: "migrated", actual, expected, marker: readSkillmuxMarker(targetDir) ?? undefined };
}

export interface RestoreMonolithResult {
  restored: boolean;
}

export function restoreMonolith(targetDir: string, vaultPath: string): RestoreMonolithResult {
  const marker = readSkillmuxMarker(targetDir);
  if (!marker) {
    return { restored: false };
  }
  if (marker.role === "local_vault") {
    throw new Error(`${targetDir} has a local_vault marker, not target ownership`);
  }
  if (marker.schema_version === undefined) {
    throw new Error(`${targetDir} has a legacy marker; migrate it before restoring full-vault delivery`);
  }
  if (marker.vault_path !== vaultPath) {
    throw new Error(
      `${targetDir} marker recorded vault_path ${marker.vault_path}, currently configured vault_path is ${vaultPath}`,
    );
  }
  const managedEntries = new Set(marker.managed_entries ?? []);
  const unmanagedEntries = readdirSync(targetDir).filter(
    (name) =>
      name !== SKILLMUX_MARKER_FILENAME &&
      name !== LEGACY_MARKER_FILENAME &&
      !managedEntries.has(name),
  );
  if (unmanagedEntries.length > 0) {
    throw new Error(`refusing to restore over unmanaged entries in ${targetDir}: ${unmanagedEntries.join(", ")}`);
  }
  rmSync(targetDir, { recursive: true, force: true });
  symlinkSync(vaultPath, targetDir);
  return { restored: true };
}

export function resolveProjectPinDir(targetDir: string, path: string): string {
  const rel = relative(homedir(), targetDir);
  if (rel === "" || rel.startsWith("..")) {
    throw new Error(
      `target dir "${targetDir}" must be inside $HOME to compute a project pin dir (got relative path "${rel}")`,
    );
  }
  return join(path, rel);
}

export interface ProjectGroupInput {
  paths: string[];
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
  path: string;
  pinDir: string;
}

export function syncProjectTargets(
  params: SyncProjectTargetsParams,
  options: SyncTargetOptions = {},
): ProjectPinSyncResult[] {
  const { vaultPath, targetDir, targetName, projectGroups, localVaultPaths = [] } = params;
  const results: ProjectPinSyncResult[] = [];

  for (const [group, projectGroup] of Object.entries(projectGroups)) {
    for (const path of projectGroup.paths) {
      if (!existsSync(path)) continue;
      const pinDir = resolveProjectPinDir(targetDir, path);
      const result = syncTarget(
        { vaultPath, targetDir: pinDir, targetName, coreSkillIds: projectGroup.skills, localVaultPaths },
        options,
      );
      results.push({ group, path, pinDir, ...result });
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
