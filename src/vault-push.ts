import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseManifest } from "./manifest";
import { scanExitCode, scanPath, type ScanFinding, type ScanSeverity } from "./scan";
import { PackError, unpackEntries, type PackEntry, type PackErrorCode, type PackLimits } from "./vault-pack";
import { decodeUtf8Strict, parseSkillMd, SKILL_ID_PATTERN } from "./vault";

export type VaultPushErrorCode = PackErrorCode | "SCAN_REJECTED" | "VAULT_MANAGED_BY_GIT" | "IO_ERROR";

export class VaultPushError extends Error {
  constructor(
    readonly code: VaultPushErrorCode,
    message: string,
    readonly findings?: ScanFinding[],
  ) {
    super(message);
    this.name = "VaultPushError";
  }
}

export interface VaultPushResult {
  status: "replaced" | "dry-run";
  content_sha256: string;
  skills: string[];
  files: number;
  bytes: number;
  /** Findings below the fail_on threshold. They were accepted and are reported so the caller sees them. */
  findings: ScanFinding[];
}

export interface VaultPushOptions {
  vaultPath: string;
  limits: PackLimits;
  /** Findings at or above this severity reject the push. undefined accepts any content. */
  failOn: ScanSeverity | undefined;
  dryRun: boolean;
  /**
   * Runs the callback while no query can read the vault and the watcher is
   * paused. The swap and the reindex happen inside it, so a query sees either
   * the old vault or the new one, never a mix.
   */
  exclusive: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Takes the new tree into the index. Called inside `exclusive`, after the swap. */
  reindex: () => Promise<void>;
  warn?: (message: string) => void;
  /** Replaceable in tests to fail the swap partway. */
  rename?: (from: string, to: string) => void;
}

const MANIFEST = "skillmux.toml";
const STAGE_PREFIX = ".skillmux-push-";
const TRASH_PREFIX = ".skillmux-trash-";
/** A staging directory older than this belongs to a push that crashed, not one that is running. */
const STALE_STAGE_MS = 3_600_000;

function ioError(what: string, error: unknown): VaultPushError {
  const detail = error instanceof Error ? error.message : String(error);
  return new VaultPushError("IO_ERROR", `${what}: ${detail}`);
}

function skillsOf(entries: PackEntry[]): string[] {
  return [...new Set(entries.filter((e) => e.path !== MANIFEST).map((e) => e.path.split("/")[0]!))].sort();
}

/** Every skill needs a SKILL.md that parses, and a push must carry at least one skill. */
function checkLayout(entries: PackEntry[]): string[] {
  const skills = skillsOf(entries);
  if (skills.length === 0) throw new VaultPushError("INVALID_PACK", "the pack contains no skills");
  for (const skillId of skills) {
    const main = entries.find((e) => e.path === `${skillId}/SKILL.md`);
    if (!main) throw new VaultPushError("INVALID_PACK", `${skillId} has no SKILL.md`);
    try {
      parseSkillMd(skillId, decodeUtf8Strict(main.bytes));
    } catch (error) {
      throw new VaultPushError("INVALID_PACK", `${skillId}/SKILL.md is not a valid skill: ${error instanceof Error ? error.message : error}`);
    }
  }
  // The server never acts on skillmux.toml, but the CLI and /metrics read it, so a manifest
  // that does not parse would break them for every later request.
  const manifest = entries.find((e) => e.path === MANIFEST);
  if (manifest) {
    try {
      parseManifest(decodeUtf8Strict(manifest.bytes));
    } catch (error) {
      throw new VaultPushError("INVALID_PACK", `${MANIFEST} is not valid: ${error instanceof Error ? error.message : error}`);
    }
  }
  return skills;
}

function sweepStaleStages(vaultPath: string): void {
  if (!existsSync(vaultPath)) return;
  for (const name of readdirSync(vaultPath)) {
    if (!name.startsWith(STAGE_PREFIX)) continue;
    try {
      if (Date.now() - statSync(join(vaultPath, name)).mtimeMs > STALE_STAGE_MS) {
        rmSync(join(vaultPath, name), { recursive: true, force: true });
      }
    } catch {
      // A directory that vanishes or cannot be read is not worth failing a push over.
    }
  }
}

/** The top-level entries a push replaces: skill directories, symlinked or not, and the manifest. */
function replaceableNames(vaultPath: string): string[] {
  if (!existsSync(vaultPath)) return [];
  const names: string[] = [];
  for (const item of readdirSync(vaultPath, { withFileTypes: true })) {
    if (item.name === MANIFEST && !item.isDirectory()) names.push(item.name);
    else if (SKILL_ID_PATTERN.test(item.name) && (item.isDirectory() || item.isSymbolicLink())) names.push(item.name);
  }
  return names;
}

function writeStage(stage: string, entries: PackEntry[]): void {
  for (const entry of entries) {
    const target = join(stage, entry.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, entry.bytes, { flag: "wx" });
  }
}

/**
 * Replaces the served vault with an uploaded pack. Everything that can reject
 * the pack happens before the vault is touched: the pack is validated, written
 * to a staging directory inside the vault (the same filesystem, so renames are
 * cheap and atomic, and a mount point can be the vault itself), and scanned
 * there. The swap is then a short run of renames with the old entries parked
 * in a trash directory, so a failure partway puts everything back.
 */
export async function applyVaultPush(body: Uint8Array, options: VaultPushOptions): Promise<VaultPushResult> {
  const { vaultPath, failOn } = options;
  const warn = options.warn ?? (() => {});
  const rename = options.rename ?? renameSync;

  let unpacked: ReturnType<typeof unpackEntries>;
  try {
    unpacked = unpackEntries(body, options.limits);
  } catch (error) {
    if (error instanceof PackError) throw new VaultPushError(error.code, error.message);
    throw error;
  }
  const { entries, content_sha256 } = unpacked;
  const skills = checkLayout(entries);
  const bytes = entries.reduce((sum, e) => sum + e.bytes.length, 0);

  if (existsSync(join(vaultPath, ".git"))) {
    throw new VaultPushError("VAULT_MANAGED_BY_GIT", `${vaultPath} is a git checkout; a push would fight the repository for it`);
  }

  const stage = join(vaultPath, `${STAGE_PREFIX}${randomUUID()}`);
  const trash = join(vaultPath, `${TRASH_PREFIX}${randomUUID()}`);
  // The trash directory is the only copy of the old vault if a restore fails, so it must outlive that failure.
  let keepTrash = false;
  try {
    try {
      mkdirSync(vaultPath, { recursive: true });
      sweepStaleStages(vaultPath);
      mkdirSync(stage);
      writeStage(stage, entries);
    } catch (error) {
      throw ioError(`cannot stage the pack under ${vaultPath}`, error);
    }

    const scan = await scanPath(stage);
    const blocking = scan.findings.filter((finding) => scanExitCode([finding], failOn) === 1);
    if (blocking.length > 0) {
      throw new VaultPushError(
        "SCAN_REJECTED",
        `${blocking.length} finding${blocking.length === 1 ? "" : "s"} at or above ${failOn}`,
        blocking,
      );
    }
    const accepted = scan.findings;
    const summary = { content_sha256, skills, files: entries.length, bytes, findings: accepted };
    if (options.dryRun) return { status: "dry-run", ...summary };

    await options.exclusive(async () => {
      const trashed: string[] = [];
      const placed: string[] = [];
      try {
        mkdirSync(trash);
        for (const name of replaceableNames(vaultPath)) {
          rename(join(vaultPath, name), join(trash, name));
          trashed.push(name);
        }
        for (const name of readdirSync(stage)) {
          rename(join(stage, name), join(vaultPath, name));
          placed.push(name);
        }
      } catch (error) {
        try {
          for (const name of placed.reverse()) rmSync(join(vaultPath, name), { recursive: true, force: true });
          for (const name of trashed.reverse()) renameSync(join(trash, name), join(vaultPath, name));
        } catch (restoreError) {
          keepTrash = true;
          throw ioError(
            `swap failed and the old vault could not be fully restored; the old entries are in ${trash}`,
            restoreError,
          );
        }
        throw ioError("swap failed; the old vault was restored", error);
      }
      try {
        await options.reindex();
      } catch (error) {
        // The files are in place, and the next query reindexes by fingerprint anyway.
        warn(`vault push: reindex failed, the next query will retry: ${error instanceof Error ? error.message : error}`);
      }
    });
    return { status: "replaced", ...summary };
  } finally {
    for (const dir of keepTrash ? [stage] : [stage, trash]) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch (error) {
        warn(`vault push: could not remove ${dir}: ${error instanceof Error ? error.message : error}`);
      }
    }
  }
}
