import { emitSuccess } from "../output";
import { confirmIfNeeded } from "./shared";
import type { TargetAdapter } from "../adapters";
import type { ResolvedContext } from "../context";

export async function runAudit(
  subCommand: string,
  args: string[],
  options: { isJson: boolean; dryRun: boolean; target: ResolvedContext; adapter: TargetAdapter },
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
    else if (arg === "--json" || arg === "--allow-insecure" || arg === "--verbose") {
      // handled globally by main()'s flags; recognized here so it isn't rejected
    } else if (arg === "--context" || arg === "--server") {
      i++; // skip flag value
    } else if (arg?.startsWith("--")) {
      throw new Error(`unknown audit prune option: ${arg}`);
    }
  }

  if (dryRun) {
    const counts = await options.adapter.auditCount(olderThan);
    emitSuccess(
      { isJson: options.isJson },
      counts,
      () =>
        console.log(
          counts.cutoff === null
            ? "prune: audit.retention_days is 0 (pruning disabled); nothing to do"
            : `prune: audit=${counts.audit_deleted} fetch=${counts.fetch_deleted} admin_audit=${counts.admin_audit_deleted} (dry-run)`,
        ),
    );
    return;
  }

  // Pre-fetch count / cutoff info for confirmation prompt if local or remote
  const countResult = await options.adapter.auditCount(olderThan);
  if (countResult.cutoff === null) {
    emitSuccess(
      { isJson: options.isJson },
      { audit_deleted: 0, fetch_deleted: 0, admin_audit_deleted: 0, dry_run: false, cutoff: null },
      () => console.log("prune: audit.retention_days is 0 (pruning disabled); nothing to do"),
    );
    return;
  }

  if (
    !(await confirmIfNeeded({
      confirmed: yes,
      isJson: options.isJson,
      prompt: `prune audit rows older than ${countResult.cutoff}?`,
      nonInteractiveError: "skillmux audit prune requires --yes when run non-interactively",
    }))
  )
    return;

  // Reuse the exact cutoff already shown in the confirmation prompt — recomputing
  // it here (if olderThan was left unset) could drift from what was confirmed,
  // e.g. if audit.retention_days changed between the two calls on a remote target.
  const counts = await options.adapter.auditPrune({
    older_than: countResult.cutoff,
    dry_run: false,
    confirm: true,
  });
  emitSuccess(
    { isJson: options.isJson },
    counts,
    () =>
      console.log(
        `prune: audit=${counts.audit_deleted} fetch=${counts.fetch_deleted} admin_audit=${counts.admin_audit_deleted}`,
      ),
  );
}
