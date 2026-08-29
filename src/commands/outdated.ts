import { readdirSync } from "node:fs";
import { join } from "node:path";
import { expandHome, loadConfig } from "../config";
import { remoteHeadCommit } from "../install";
import { emitSuccess } from "../output";
import { readSkillOrigin } from "../provenance";
import { SKILL_ID_PATTERN } from "../vault";

export interface OutdatedCheckResult {
  skill_id: string;
  source_url: string;
  recorded_commit: string;
  remote_commit: string | null;
  status: "up_to_date" | "outdated" | "check_failed";
  reason: string | null;
}

function vaultSkillIds(vaultPath: string): string[] {
  return readdirSync(vaultPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && SKILL_ID_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

export async function checkOutdated(vaultPath: string): Promise<OutdatedCheckResult[]> {
  const results: OutdatedCheckResult[] = [];
  for (const skillId of vaultSkillIds(vaultPath)) {
    const origin = readSkillOrigin(join(vaultPath, skillId));
    if (!origin) continue;

    let remoteCommit: string | null = null;
    let status: OutdatedCheckResult["status"];
    let reason: string | null = null;
    try {
      remoteCommit = await remoteHeadCommit(origin.source_url);
      status = remoteCommit === origin.commit ? "up_to_date" : "outdated";
    } catch (error) {
      status = "check_failed";
      reason = error instanceof Error ? error.message : String(error);
    }

    results.push({
      skill_id: skillId,
      source_url: origin.source_url,
      recorded_commit: origin.commit,
      remote_commit: remoteCommit,
      status,
      reason,
    });
  }
  return results;
}

export async function runOutdated(args: string[], options: { isJson: boolean }): Promise<void> {
  for (const arg of args) {
    if (arg === "--json") continue;
    throw new Error(`unknown outdated option: ${arg}`);
  }

  const vaultPath = expandHome((await loadConfig()).vault_path);
  const skills = await checkOutdated(vaultPath);
  const checksFailed = skills.filter((s) => s.status === "check_failed").length;
  process.exitCode = checksFailed > 0 ? 1 : 0;

  emitSuccess({ isJson: options.isJson }, { skills, checks_failed: checksFailed }, () => {
    if (skills.length === 0) {
      console.log("outdated: no vault skills carry provenance");
      return;
    }
    for (const s of skills) {
      const suffix = s.status === "check_failed" ? ` — ${s.reason}` : "";
      console.log(`[${s.status}] ${s.skill_id}${suffix}`);
    }
  });
}
