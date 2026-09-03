import { rmSync } from "node:fs";
import { join } from "node:path";
import { expandHome, loadConfig } from "../config";
import {
  assertHostAllowed,
  cloneToTemp,
  deriveRepoName,
  installIntoVault,
  isLocalFileUrl,
  resolveCloneCommit,
  resolveRepoSource,
  resolveSkillDir,
  validateSkillCandidate,
} from "../install";
import { emitSuccess } from "../output";
import { hashSkillContent, writeSkillOrigin } from "../provenance";
import {
  FAIL_ON_USAGE,
  parseFailOn,
  renderScanText,
  resolveMutatingFailOn,
  scanExitCode,
  type FailOnOption,
} from "../scan";
import { isGlobalFlag } from "../global-flags";

function parseInstallArgs(args: string[]): {
  repo?: string;
  force: boolean;
  dryRun: boolean;
  failOn?: FailOnOption;
  allowLocalSource: boolean;
} {
  let repo: string | undefined;
  let force = false;
  let dryRun = false;
  let failOn: FailOnOption | undefined;
  let allowLocalSource = false;
  for (let i = 0; i < args.length; i++) {
    const option = args[i];
    if (option === "--force") force = true;
    else if (option === "--dry-run") dryRun = true;
    else if (option === "--allow-local-source") allowLocalSource = true;
    else if (option === "--fail-on") {
      failOn = parseFailOn(args[++i]);
    } else if (isGlobalFlag(option, "--json", "--verbose")) {
      // handled globally by main()'s isJson/isVerbose flags; recognized here so they aren't rejected
    } else if (option?.startsWith("--")) {
      throw new Error(`unknown install option: ${option}`);
    } else if (repo !== undefined) {
      throw new Error("skillmux install accepts at most one <repo> argument");
    } else {
      repo = option;
    }
  }
  return { repo, force, dryRun, failOn, allowLocalSource };
}

export async function runInstall(
  args: string[],
  options: { isJson: boolean },
): Promise<void> {
  const { repo, force, dryRun, failOn, allowLocalSource } = parseInstallArgs(args);
  if (!repo) {
    throw new Error(
      `usage: skillmux install <repo>[/path] [--force] [--fail-on ${FAIL_ON_USAGE}] [--dry-run] [--allow-local-source] [--json]`,
    );
  }

  const source = resolveRepoSource(repo);
  if (!allowLocalSource && isLocalFileUrl(source.url)) {
    throw new Error(
      `"${repo}" is a local (file://) source — pass --allow-local-source to install from it`,
    );
  }
  const config = await loadConfig();
  assertHostAllowed(source.url, config.egress?.allowed_hosts);
  const cloneDir = await cloneToTemp(source.url);
  try {
    const resolved = resolveSkillDir(
      cloneDir,
      deriveRepoName(source.url),
      source.skillPath,
    );
    const { findings } = await validateSkillCandidate(
      resolved.skillId,
      resolved.dir,
    );
    if (!options.isJson) console.log(renderScanText({ scanned: 1, findings }));

    // Defaults to blocking on a high-severity finding. Printing the findings
    // and installing anyway is the wrong default for the command that pulls
    // remote content into the vault.
    const effectiveFailOn = resolveMutatingFailOn(failOn);
    if (scanExitCode(findings, effectiveFailOn) !== 0) {
      process.exitCode = 1;
      console.error(
        `aborting install: a finding met the --fail-on ${effectiveFailOn} threshold` +
          (failOn === undefined ? " (the default)" : "") +
          `; re-run with --fail-on none to install anyway`,
      );
      return;
    }

    const vaultPath = expandHome(config.vault_path);
    if (dryRun) {
      const plannedPath = join(vaultPath, resolved.skillId);
      emitSuccess(
        { isJson: options.isJson },
        { skill_id: resolved.skillId, would_install_at: plannedPath },
        () =>
          console.log(
            `dry-run: would install "${resolved.skillId}" into ${plannedPath}`,
          ),
      );
      return;
    }

    const commit = resolveCloneCommit(cloneDir);
    const targetDir = installIntoVault(
      vaultPath,
      resolved.skillId,
      resolved.dir,
      force,
    );
    writeSkillOrigin(targetDir, {
      source_url: source.url,
      skill_path: source.skillPath,
      commit,
      installed_at: new Date().toISOString(),
      content_hash: hashSkillContent(targetDir),
    });
    emitSuccess(
      { isJson: options.isJson },
      { skill_id: resolved.skillId, installed_at: targetDir },
      () => console.log(`installed "${resolved.skillId}" into ${targetDir}`),
    );
  } finally {
    rmSync(cloneDir, { recursive: true, force: true });
  }
}
