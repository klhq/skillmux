import { existsSync } from "node:fs";
import { join } from "node:path";
import { usageError } from "../arg-errors";
import { installIntoVault, resolveCloneCommit, validateSkillCandidate, type RepoSource } from "../install";
import { discoverSkills, type DiscoveredSkill } from "../install-all";
import { dryRunTag, emitSuccess } from "../output";
import { hashSkillContent, writeSkillOrigin } from "../provenance";
import { type FailOnOption, type ScanFinding, renderScanText, resolveMutatingFailOn, scanExitCode } from "../scan";
import { confirmIfNeeded } from "./shared";

interface Outcome {
  skill_id: string;
  path: string;
}

interface CollectionResult {
  repo: string;
  commit: string;
  installed: (Outcome & { installed_at: string })[];
  skipped: (Outcome & { reason: string })[];
  blocked: (Outcome & { reason: string; findings: number })[];
  invalid: { path: string; skill_id?: string; reason: string }[];
  dry_run: boolean;
}

export interface InstallCollectionOptions {
  cloneDir: string;
  source: RepoSource;
  vaultPath: string;
  force: boolean;
  dryRun: boolean;
  yes: boolean;
  failOn: FailOnOption | undefined;
  only: string[];
  atomic: boolean;
  isJson: boolean;
}

const USAGE_HINT = "usage: skillmux install <repo> [--only <id>[,<id>...]] [--atomic] [--dry-run] [--yes]";

/**
 * Installs every skill found in a repository that has no SKILL.md at its root
 * and no path was given. Each skill is checked on its own, so one bad skill
 * costs only itself unless --atomic asks for all or nothing. Nothing is written
 * until every skill has been checked and the plan shown.
 */
export async function installCollection(options: InstallCollectionOptions): Promise<void> {
  const { cloneDir, source, vaultPath, force, atomic, isJson } = options;
  const discovered = discoverSkills(cloneDir);
  if (discovered.skills.length === 0 && discovered.invalid.length === 0) {
    throw new Error("no SKILL.md at repo root and no skill dirs found under it");
  }

  let candidates: DiscoveredSkill[] = discovered.skills;
  const invalidDirs = discovered.invalid;
  if (options.only.length > 0) {
    const known = new Set(discovered.skills.map((skill) => skill.skillId));
    const unknown = options.only.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      throw usageError(
        `--only names ${unknown.map((id) => `"${id}"`).join(", ")}, which the repository does not contain; it has: ${[...known].join(", ") || "(no valid skills)"}`,
        USAGE_HINT,
      );
    }
    const wanted = new Set(options.only);
    candidates = candidates.filter((skill) => wanted.has(skill.skillId));
  }

  const result: CollectionResult = {
    repo: source.url,
    commit: resolveCloneCommit(cloneDir),
    installed: [],
    skipped: [],
    blocked: [],
    invalid: options.only.length > 0 ? [] : invalidDirs.map((entry) => ({ ...entry })),
    dry_run: options.dryRun,
  };

  const failOn = resolveMutatingFailOn(options.failOn);
  const allFindings: ScanFinding[] = [];
  const toInstall: DiscoveredSkill[] = [];
  for (const skill of candidates) {
    if (existsSync(join(vaultPath, skill.skillId)) && !force) {
      result.skipped.push({ skill_id: skill.skillId, path: skill.path, reason: "already in the vault; pass --force to overwrite" });
      continue;
    }
    let findings: ScanFinding[];
    try {
      findings = (await validateSkillCandidate(skill.skillId, skill.dir)).findings;
    } catch (error) {
      result.invalid.push({ path: skill.path, skill_id: skill.skillId, reason: error instanceof Error ? error.message : String(error) });
      continue;
    }
    allFindings.push(...findings);
    if (scanExitCode(findings, failOn) !== 0) {
      result.blocked.push({
        skill_id: skill.skillId,
        path: skill.path,
        findings: findings.length,
        reason: `a finding met the --fail-on ${failOn} threshold`,
      });
      continue;
    }
    toInstall.push(skill);
  }

  if (!isJson) {
    console.log(renderScanText({ scanned: candidates.length - result.skipped.length, findings: allFindings }));
  }

  const problems = result.blocked.length + result.invalid.length;
  if (problems > 0) process.exitCode = 1;
  if (atomic && problems > 0) {
    emitOrRender(result, isJson, "atomic: nothing was installed");
    return;
  }

  if (options.dryRun) {
    result.installed = toInstall.map((skill) => ({ skill_id: skill.skillId, path: skill.path, installed_at: join(vaultPath, skill.skillId) }));
    emitOrRender(result, isJson, `would install ${toInstall.length} skill(s) ${dryRunTag()}`);
    return;
  }

  if (toInstall.length === 0) {
    emitOrRender(result, isJson, "nothing to install");
    return;
  }

  const proceed = await confirmIfNeeded({
    confirmed: options.yes,
    isJson,
    prompt: `install ${toInstall.length} skill(s) from ${source.url}:\n  ${toInstall.map((skill) => skill.skillId).join("\n  ")}\n?`,
    nonInteractiveError: "skillmux install requires --yes when run non-interactively",
  });
  if (!proceed) return;

  for (const skill of toInstall) {
    try {
      const targetDir = installIntoVault(vaultPath, skill.skillId, skill.dir, force);
      writeSkillOrigin(targetDir, {
        source_url: source.url,
        skill_path: skill.path,
        commit: result.commit,
        installed_at: new Date().toISOString(),
        content_hash: hashSkillContent(targetDir),
      });
      result.installed.push({ skill_id: skill.skillId, path: skill.path, installed_at: targetDir });
    } catch (error) {
      process.exitCode = 1;
      result.invalid.push({ path: skill.path, skill_id: skill.skillId, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  emitOrRender(result, isJson, `installed ${result.installed.length} skill(s) into ${vaultPath}`);
}

function emitOrRender(result: CollectionResult, isJson: boolean, headline: string): void {
  emitSuccess({ isJson }, result, () => {
    console.log(headline);
    const list = (label: string, rows: string[]) => {
      if (rows.length === 0) return;
      console.log(`${label} (${rows.length}):`);
      for (const row of rows) console.log(`  ${row}`);
    };
    list("installed", result.installed.map((row) => `${row.skill_id}  (${row.path})`));
    list("skipped", result.skipped.map((row) => `${row.skill_id}  ${row.reason}`));
    list("blocked", result.blocked.map((row) => `${row.skill_id}  ${row.reason}`));
    list("invalid", result.invalid.map((row) => `${row.skill_id ?? row.path}  ${row.reason}`));
  });
}
