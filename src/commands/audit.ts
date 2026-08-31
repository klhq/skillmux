import { expandHome, loadConfig } from "../config";
import { countPrunable, openAudit, pruneAuditBefore } from "../db";
import { parseSince } from "../stats";
import { emitSuccess } from "../output";
import { confirmIfNeeded } from "./shared";

export async function runAudit(
  subCommand: string,
  args: string[],
  options: { isJson: boolean; dryRun: boolean },
): Promise<void> {
  if (subCommand !== "prune") {
    throw new Error("usage: skillmux audit prune [--older-than <window>] [--dry-run] [--yes] [--json]");
  }

  let olderThan: string | undefined;
  let dryRun = options.dryRun;
  let yes = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--older-than") olderThan = args[++i];
    else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--yes") yes = true;
    else if (arg === "--json") {
      // handled globally by main()'s isJson flag; recognized here so it isn't rejected
    } else if (arg?.startsWith("--")) {
      throw new Error(`unknown audit prune option: ${arg}`);
    }
  }

  const config = await loadConfig();
  const stateDir = expandHome(config.state_dir);

  let cutoff: Date;
  if (olderThan) {
    cutoff = parseSince(olderThan);
  } else {
    const retentionDays = config.audit?.retention_days ?? 90;
    if (retentionDays <= 0) {
      emitSuccess(
        { isJson: options.isJson },
        { audit_deleted: 0, fetch_deleted: 0, admin_audit_deleted: 0, dry_run: dryRun, cutoff: null },
        () => console.log("prune: audit.retention_days is 0 (pruning disabled); nothing to do"),
      );
      return;
    }
    cutoff = new Date(Date.now() - retentionDays * 86_400_000);
  }
  const cutoffIso = cutoff.toISOString();

  const db = openAudit(stateDir);
  try {
    if (dryRun) {
      const counts = countPrunable(db, cutoffIso);
      emitSuccess(
        { isJson: options.isJson },
        { ...counts, dry_run: true, cutoff: cutoffIso },
        () =>
          console.log(
            `prune: audit=${counts.audit_deleted} fetch=${counts.fetch_deleted} admin_audit=${counts.admin_audit_deleted} (dry-run)`,
          ),
      );
      return;
    }

    if (
      !(await confirmIfNeeded({
        confirmed: yes,
        isJson: options.isJson,
        prompt: `prune audit rows older than ${cutoffIso}?`,
        nonInteractiveError: "skillmux audit prune requires --yes when run non-interactively",
      }))
    )
      return;

    const counts = pruneAuditBefore(db, cutoffIso);
    emitSuccess(
      { isJson: options.isJson },
      { ...counts, dry_run: false, cutoff: cutoffIso },
      () =>
        console.log(
          `prune: audit=${counts.audit_deleted} fetch=${counts.fetch_deleted} admin_audit=${counts.admin_audit_deleted}`,
        ),
    );
  } finally {
    db.close();
  }
}
