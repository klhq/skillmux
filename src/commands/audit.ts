import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { unknownOptionError, usageError } from "../arg-errors";
import { countAuditExport, readAuditExport, serializeAuditExport } from "../audit-export";
import { expandHome, loadConfig } from "../config";
import { CliError, dryRunTag, emitSuccess, warn } from "../output";
import { parseSince } from "../stats";
import { confirmIfNeeded } from "./shared";
import type { ContextAdapter } from "../adapters";
import type { ResolvedContext } from "../context";
import { isGlobalFlag, isGlobalFlagWithValue } from "../global-flags";

export async function runAudit(
  subCommand: string,
  args: string[],
  options: { isJson: boolean; dryRun: boolean; context: ResolvedContext; adapter: ContextAdapter },
): Promise<void> {
  if (subCommand === "export") return runAuditExport(args, options);
  if (subCommand !== "prune") {
    throw usageError(
      subCommand ? `unknown audit subcommand "${subCommand}"` : "missing subcommand",
      `usage: skillmux audit prune [--older-than <window>] [--dry-run] [--yes] [--json]\n       ${AUDIT_EXPORT_USAGE}`,
    );
  }

  let olderThan: string | undefined;
  let dryRun = options.dryRun;
  let yes = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--older-than") olderThan = args[++i];
    else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--yes") yes = true;
    else if (isGlobalFlag(arg, "--json", "--allow-insecure", "--verbose")) {
      // handled globally by main()'s flags; recognized here so it isn't rejected
    } else if (isGlobalFlagWithValue(arg)) {
      i++; // skip flag value
    } else if (arg?.startsWith("--")) {
      throw unknownOptionError("audit prune", arg);
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
            : `prune: audit=${counts.audit_deleted} fetch=${counts.fetch_deleted} file_fetch=${counts.file_fetch_deleted ?? 0} admin_audit=${counts.admin_audit_deleted} ${dryRunTag()}`,
        ),
    );
    return;
  }

  // Pre-fetch count / cutoff info for confirmation prompt if local or remote
  const countResult = await options.adapter.auditCount(olderThan);
  if (countResult.cutoff === null) {
    emitSuccess(
      { isJson: options.isJson },
      { audit_deleted: 0, fetch_deleted: 0, file_fetch_deleted: 0, admin_audit_deleted: 0, dry_run: false, cutoff: null },
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
        `prune: audit=${counts.audit_deleted} fetch=${counts.fetch_deleted} file_fetch=${counts.file_fetch_deleted ?? 0} admin_audit=${counts.admin_audit_deleted}`,
      ),
  );
}

const AUDIT_EXPORT_USAGE =
  "skillmux audit export [--since <window>] [--db <path>] [--out <path>] [--json]";

/**
 * Writes resolve, fetch and attachment rows as JSON lines, for a deployment
 * whose audit database is not reachable from where `report` or `eval promote`
 * runs (stdio skillmux inside an MCP gateway container). The operator runs it
 * through the container's own exec, as the user that owns the database.
 */
async function runAuditExport(
  args: string[],
  options: { isJson: boolean; context: ResolvedContext },
): Promise<void> {
  let since: string | undefined;
  let dbPath: string | undefined;
  let out: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const value = args[i + 1];
    if (arg === "--since" || arg === "--db" || arg === "--out") {
      if (!value || value.startsWith("--")) throw usageError(`${arg} requires a value`, AUDIT_EXPORT_USAGE);
      if (arg === "--since") since = value;
      else if (arg === "--db") dbPath = value;
      else out = value;
      i++;
    } else if (isGlobalFlag(arg, "--json", "--allow-insecure", "--verbose")) {
      // handled globally by main()'s flags; recognized here so it isn't rejected
    } else if (isGlobalFlagWithValue(arg)) {
      i++; // skip flag value
    } else {
      throw unknownOptionError("audit export", arg);
    }
  }

  if (options.context.type === "remote") {
    throw new CliError(
      "audit export reads a local audit database and does not take --context/--server. " +
        "For an HTTP server, run report or eval promote with --context instead.",
      2,
      "REMOTE_CONTEXT_UNSUPPORTED",
    );
  }
  if (options.isJson && out === undefined) {
    throw usageError("--json needs --out; without it the export itself is written to stdout", AUDIT_EXPORT_USAGE);
  }

  const sinceIso = since === undefined ? null : parseSince(since).toISOString();
  const path = dbPath ?? join(expandHome((await loadConfig()).state_dir), "audit.sqlite3");
  if (!existsSync(path)) {
    throw new CliError(`no audit database at ${path}`, 1);
  }
  if (out !== undefined && existsSync(out)) {
    throw new CliError(`${out} already exists; remove it or choose another --out path`, 4);
  }

  // Read-only: an export must never create, migrate, or checkpoint the
  // database it reads, because the server process owns that file.
  const db = new Database(path, { readonly: true });
  let data;
  try {
    data = readAuditExport(db, sinceIso);
  } finally {
    db.close();
  }

  warn("audit exports contain raw user queries; keep the file private and out of version control");

  const text = serializeAuditExport(data);
  if (out === undefined) {
    process.stdout.write(text);
    return;
  }

  // Owner-only, and "wx" so a concurrent writer cannot swap the file in after the check above.
  writeFileSync(out, text, { mode: 0o600, flag: "wx" });
  const counts = countAuditExport(data);
  emitSuccess(
    { isJson: options.isJson },
    { path: out, since: sinceIso, exported_at: data.header.exported_at, rows: counts },
    () =>
      console.log(
        `export: resolve=${counts.resolve} fetch=${counts.fetch} file_fetch=${counts.file_fetch} to ${out}`,
      ),
  );
}
