import { Database } from "bun:sqlite";
import type { TargetAdapter } from "../adapters";
import type { ResolvedContext } from "../context";
import { emitSuccess } from "../output";
import { getStats, renderStatsText } from "../stats";

function parseReportArgs(args: string[]): {
  db?: string;
  since?: string;
} {
  let db: string | undefined;
  let since: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const option = args[i];
    const value = args[i + 1];
    if (option === "--db") {
      if (!value) throw new Error("--db requires a path");
      db = value;
      i++;
    } else if (option === "--since") {
      if (!value) throw new Error("--since requires a window");
      since = value;
      i++;
    } else if (option === "--json") {
      // handled globally by main()'s isJson flag; recognized here so it isn't rejected
    } else if (option === "--server" || option === "--context") {
      // handled globally by main()'s resolveContext(); recognized here so it isn't rejected
      i++;
    } else if (option === "--allow-insecure") {
      // handled globally by main()'s allowInsecure flag; recognized here so it isn't rejected
    } else {
      throw new Error(`unknown report option: ${option}`);
    }
  }
  return { db, since };
}

export async function runReport(
  args: string[],
  options: { isJson: boolean; target: ResolvedContext; allowInsecure: boolean; adapter: TargetAdapter },
): Promise<void> {
  const { db: dbPath, since } = parseReportArgs(args);
  if (!since)
    throw new Error(
      "usage: skillmux report [--context <name> | --server <url> | --db <path>] --since <window> [--json]",
    );
  if (dbPath && options.target.type === "remote")
    throw new Error("--db and --context/--server are mutually exclusive");

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
