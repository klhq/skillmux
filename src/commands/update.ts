import { rmSync } from "node:fs";
import { join } from "node:path";
import { expandHome, loadConfig } from "../config";
import {
  cloneToTemp,
  installIntoVault,
  isLocalFileUrl,
  remoteHeadCommit,
  resolveCloneCommit,
  resolveSkillDir,
  validateSkillCandidate,
} from "../install";
import { emitSuccess } from "../output";
import { hashSkillContent, readSkillOrigin, writeSkillOrigin } from "../provenance";
import type { SkillOrigin } from "../provenance";
import { type ScanFinding, type ScanSeverity, scanExitCode } from "../scan";
import { confirmIfNeeded } from "./shared";
import { checkOutdated } from "./outdated";

type UpdateKind = "update" | "up_to_date" | "skip_drift" | "skip_scan_failed" | "skip_read_error";

interface UpdatePlanItem {
  skillId: string;
  oldCommit: string;
  newCommit: string;
  contentChanged: boolean;
  kind: UpdateKind;
  findings?: ScanFinding[];
  reason?: string;
  cloneDir: string | null;
  fetchedDir: string | null;
  origin: SkillOrigin;
}

async function resolveCandidateOrigins(
  vaultPath: string,
  skillId: string | undefined,
  allowLocalSource: boolean,
): Promise<{ skillId: string; origin: SkillOrigin }[]> {
  if (skillId) {
    let origin: SkillOrigin | null;
    try {
      origin = readSkillOrigin(join(vaultPath, skillId));
    } catch (error) {
      throw new Error(
        `"${skillId}" has a corrupt .skillmux-origin sidecar: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!origin) {
      throw new Error(`"${skillId}" has no origin recorded — was this skill installed via "skillmux install"?`);
    }
    if (!allowLocalSource && isLocalFileUrl(origin.source_url)) {
      throw new Error(`"${skillId}" has a local (file://) source — pass --allow-local-source to update it`);
    }
    return [{ skillId, origin }];
  }
  const outdated = await checkOutdated(vaultPath, { allowLocalSource });
  return outdated
    .filter((result) => result.status === "outdated")
    .map((result) => ({ skillId: result.skill_id, origin: readSkillOrigin(join(vaultPath, result.skill_id))! }));
}

async function buildPlan(
  vaultPath: string,
  candidates: { skillId: string; origin: SkillOrigin }[],
  failOn: ScanSeverity | undefined,
  force: boolean,
): Promise<UpdatePlanItem[]> {
  const plan: UpdatePlanItem[] = [];
  for (const { skillId, origin } of candidates) {
    const skillDir = join(vaultPath, skillId);
    let currentHash: string;
    try {
      currentHash = hashSkillContent(skillDir);
    } catch (error) {
      // A skill whose on-disk content can't be safely read (e.g. SKILL.md was
      // swapped for a symlink after install — same threat model as AC7's drift
      // check) is this skill's problem alone, matching checkOutdated's per-skill
      // isolation: never let it abort the batch for every other candidate.
      plan.push({
        skillId,
        oldCommit: origin.commit,
        newCommit: origin.commit,
        contentChanged: false,
        kind: "skip_read_error",
        reason: error instanceof Error ? error.message : String(error),
        cloneDir: null,
        fetchedDir: null,
        origin,
      });
      continue;
    }

    // Drift is a purely local comparison — check it before fetching anything,
    // so a drifted (and therefore skipped) skill never pays for a clone.
    if (currentHash !== origin.content_hash && !force) {
      plan.push({
        skillId,
        oldCommit: origin.commit,
        newCommit: await remoteHeadCommit(origin.source_url),
        contentChanged: false,
        kind: "skip_drift",
        cloneDir: null,
        fetchedDir: null,
        origin,
      });
      continue;
    }

    const cloneDir = await cloneToTemp(origin.source_url);
    const resolved = resolveSkillDir(cloneDir, skillId, origin.skill_path);
    const base = {
      skillId,
      oldCommit: origin.commit,
      newCommit: resolveCloneCommit(cloneDir),
      cloneDir,
      fetchedDir: resolved.dir,
      origin,
    };

    const { findings } = await validateSkillCandidate(skillId, resolved.dir);
    if (scanExitCode(findings, failOn) !== 0) {
      plan.push({ ...base, contentChanged: false, kind: "skip_scan_failed", findings });
      continue;
    }

    const contentChanged = hashSkillContent(resolved.dir) !== currentHash;
    plan.push({
      ...base,
      contentChanged,
      kind: base.newCommit === origin.commit && !contentChanged ? "up_to_date" : "update",
    });
  }
  return plan;
}

export function buildConfirmPrompt(toWrite: Pick<UpdatePlanItem, "skillId" | "origin">[]): string {
  const lines = toWrite.map((item) => `  ${item.skillId} <- ${item.origin.source_url}`);
  return `update:\n${lines.join("\n")}\n?`;
}

function statusFor(kind: UpdateKind, dryRun: boolean): string {
  switch (kind) {
    case "update":
      return dryRun ? "would_update" : "updated";
    case "skip_drift":
      return dryRun ? "would_skip_drift" : "skipped_drift";
    case "skip_scan_failed":
      return dryRun ? "would_skip_scan_failed" : "skipped_scan_failed";
    case "skip_read_error":
      return "skipped_read_error";
    default:
      return "up_to_date";
  }
}

function parseUpdateArgs(args: string[]): {
  skillId?: string;
  yes: boolean;
  dryRun: boolean;
  force: boolean;
  failOn?: ScanSeverity;
  allowLocalSource: boolean;
} {
  let skillId: string | undefined;
  let yes = false;
  let dryRun = false;
  let force = false;
  let failOn: ScanSeverity | undefined;
  let allowLocalSource = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--yes") yes = true;
    else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--force") force = true;
    else if (arg === "--allow-local-source") allowLocalSource = true;
    else if (arg === "--fail-on") {
      const value = args[++i];
      if (value !== "low" && value !== "medium" && value !== "high") {
        throw new Error("--fail-on must be low, medium, or high");
      }
      failOn = value;
    } else if (arg === "--json") {
      // handled globally
    } else if (arg?.startsWith("--")) {
      throw new Error(`unknown update option: ${arg}`);
    } else if (skillId !== undefined) {
      throw new Error("skillmux update accepts at most one <skill-id> argument");
    } else {
      skillId = arg;
    }
  }
  return { skillId, yes, dryRun, force, failOn, allowLocalSource };
}

export async function runUpdate(args: string[], options: { isJson: boolean }): Promise<void> {
  const { skillId, yes, dryRun, force, failOn, allowLocalSource } = parseUpdateArgs(args);
  const vaultPath = expandHome((await loadConfig()).vault_path);

  const candidates = await resolveCandidateOrigins(vaultPath, skillId, allowLocalSource);
  const plan = await buildPlan(vaultPath, candidates, failOn, force);
  try {
    const toWrite = plan.filter((item) => item.kind === "update");

    if (!dryRun && toWrite.length > 0) {
      const proceed = await confirmIfNeeded({
        confirmed: yes,
        isJson: options.isJson,
        prompt: buildConfirmPrompt(toWrite),
        nonInteractiveError: "skillmux update requires --yes when run non-interactively",
      });
      if (!proceed) return;

      for (const item of toWrite) {
        // toWrite is filtered to kind === "update", which is only ever set after
        // a successful clone above, so fetchedDir is always populated here.
        const targetDir = installIntoVault(vaultPath, item.skillId, item.fetchedDir as string, true);
        writeSkillOrigin(targetDir, {
          source_url: item.origin.source_url,
          skill_path: item.origin.skill_path,
          commit: item.newCommit,
          installed_at: new Date().toISOString(),
          content_hash: hashSkillContent(targetDir),
        });
      }
    }

    const skills = plan.map((item) => ({
      skill_id: item.skillId,
      source_url: item.origin.source_url,
      old_commit: item.oldCommit,
      new_commit: item.newCommit,
      content_changed: item.contentChanged,
      status: statusFor(item.kind, dryRun),
      ...(item.findings ? { findings: item.findings } : {}),
      ...(item.reason ? { reason: item.reason } : {}),
    }));

    emitSuccess({ isJson: options.isJson }, { dry_run: dryRun, skills }, () => {
      if (skills.length === 0) {
        console.log("update: nothing to do");
        return;
      }
      for (const s of skills) {
        console.log(`[${s.status}] ${s.skill_id}`);
      }
    });
  } finally {
    for (const item of plan) {
      if (item.cloneDir) rmSync(item.cloneDir, { recursive: true, force: true });
    }
  }
}
