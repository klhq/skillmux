import { unknownOptionError, usageError } from "../arg-errors";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { exportWindow, parseAuditExport, statsFromExport } from "../audit-export";
import type { ContextAdapter } from "../adapters";
import type { ResolvedContext } from "../context";
import { emitSuccess, warn } from "../output";
import { getStats, renderStatsText } from "../stats";
import { isGlobalFlag, isGlobalFlagWithValue } from "../global-flags";

const REPORT_USAGE =
  "usage: skillmux report [--context <name> | --server <url> | --db <path> | --from <export.jsonl>] --since <window> [--json]";

function parseReportArgs(args: string[]): {
  db?: string;
  from?: string;
  since?: string;
} {
  let db: string | undefined;
  let from: string | undefined;
  let since: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const option = args[i];
    const value = args[i + 1];
    if (option === "--db") {
      if (!value) throw new Error("--db requires a path");
      db = value;
      i++;
    } else if (option === "--from") {
      if (!value) throw new Error("--from requires a path");
      from = value;
      i++;
    } else if (option === "--since") {
      if (!value) throw new Error("--since requires a window");
      since = value;
      i++;
    } else if (isGlobalFlag(option, "--json", "--allow-insecure")) {
      // handled globally by main()'s isJson/allowInsecure flags; recognized here so it isn't rejected
    } else if (isGlobalFlagWithValue(option)) {
      // handled globally by main()'s resolveContext(); recognized here so it isn't rejected
      i++;
    } else {
      throw unknownOptionError("report", option);
    }
  }
  return { db, from, since };
}

export async function runReport(
  args: string[],
  options: { isJson: boolean; context: ResolvedContext; allowInsecure: boolean; adapter: ContextAdapter },
): Promise<void> {
  const { db: dbPath, from, since } = parseReportArgs(args);
  if (!since) throw usageError("missing required option --since <window>", REPORT_USAGE);
  if (dbPath && options.context.type === "remote")
    throw new Error("--db and --context/--server are mutually exclusive");
  if (from && (dbPath || options.context.type === "remote"))
    throw usageError("--from cannot be combined with --db, --context or --server", REPORT_USAGE);

  if (from) {
    const data = parseAuditExport(readFileSync(from, "utf-8"));
    if (!exportWindow(data, since).covered) {
      warn(
        `the export starts at ${data.header.since}, after the start of the requested window; ` +
          "counts cover only the exported rows",
      );
    }
    const stats = statsFromExport(data, since);
    emitSuccess({ isJson: options.isJson }, stats, () => console.log(renderStatsText(stats)));
    return;
  }

  if (dbPath) {
    const db = new Database(dbPath, { readonly: true });
    try {
      const stats = getStats(db, since);
      emitSuccess({ isJson: options.isJson }, stats, () =>
        console.log(renderStatsText(stats)),
      );
    } finally {
      db.close();
    }
    return;
  }

  const stats = await options.adapter.getStats(since);
  emitSuccess({ isJson: options.isJson }, stats, () =>
    console.log(renderStatsText(stats)),
  );
}
