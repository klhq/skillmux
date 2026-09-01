import { readdirSync } from "node:fs";
import { join } from "node:path";
import { expandHome, loadConfig } from "../config";
import { assertHostAllowed, isLocalFileUrl, remoteHeadCommit } from "../install";
import { emitSuccess } from "../output";
import { readSkillOrigin } from "../provenance";
import { SKILL_ID_PATTERN } from "../vault";
import { isGlobalFlag } from "../global-flags";

export interface OutdatedCheckResult {
  skill_id: string;
  source_url: string;
  recorded_commit: string;
  remote_commit: string | null;
  status: "up_to_date" | "outdated" | "check_failed" | "local_source_skipped";
  reason: string | null;
}

function vaultSkillIds(vaultPath: string): string[] {
  return readdirSync(vaultPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && SKILL_ID_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

export async function checkOutdated(
  vaultPath: string,
  options: { allowLocalSource?: boolean; allowedHosts?: string[] } = {},
): Promise<OutdatedCheckResult[]> {
  const results: OutdatedCheckResult[] = [];
  for (const skillId of vaultSkillIds(vaultPath)) {
    let origin: ReturnType<typeof readSkillOrigin>;
    try {
      origin = readSkillOrigin(join(vaultPath, skillId));
    } catch (error) {
      // A corrupt or unreadable sidecar is this skill's problem alone — never
      // let it abort the check for every other skill in the vault (AC3/AC4's
      // per-skill isolation applies to local parse failures too, not just
      // unreachable remotes).
      results.push({
        skill_id: skillId,
        source_url: "",
        recorded_commit: "",
        remote_commit: null,
        status: "check_failed",
        reason: `.skillmux-origin: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }
    if (!origin) continue;

    if (!options.allowLocalSource && isLocalFileUrl(origin.source_url)) {
      results.push({
        skill_id: skillId,
        source_url: origin.source_url,
        recorded_commit: origin.commit,
        remote_commit: null,
        status: "local_source_skipped",
        reason: "source_url is a local file:// path — skipped by default; pass --allow-local-source to check it",
      });
      continue;
    }

    let remoteCommit: string | null = null;
    let status: OutdatedCheckResult["status"];
    let reason: string | null = null;
    try {
      assertHostAllowed(origin.source_url, options.allowedHosts);
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
  let allowLocalSource = false;
  for (const arg of args) {
    if (isGlobalFlag(arg, "--json")) continue;
    if (arg === "--allow-local-source") {
      allowLocalSource = true;
      continue;
    }
    throw new Error(`unknown outdated option: ${arg}`);
  }

  const config = await loadConfig();
  const vaultPath = expandHome(config.vault_path);
  const skills = await checkOutdated(vaultPath, { allowLocalSource, allowedHosts: config.egress?.allowed_hosts });
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
