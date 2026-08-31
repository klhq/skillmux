import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expandHome, loadConfig } from "../config";
import { excludeExistingCases, parseEvalCases } from "../eval";
import { emitSuccess } from "../output";
import { parseSince } from "../stats";
import { confirmIfNeeded } from "./shared";
import type { TargetAdapter } from "../adapters";

export async function runEvalPromote(
  args: string[],
  options: { isJson: boolean; dryRun: boolean; adapter: TargetAdapter },
): Promise<void> {
  let since: string | undefined;
  let target: string | undefined;
  let dryRun = options.dryRun;
  let yes = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--since") since = args[++i];
    else if (arg === "--target") target = args[++i];
    else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--yes") yes = true;
    else if (arg === "--json" || arg === "--allow-insecure" || arg === "--verbose") {
      // handled globally by main()'s isJson flag; recognized here so it isn't rejected
    } else if (arg === "--context" || arg === "--server") {
      i++; // skip flag value
    } else if (arg?.startsWith("--")) {
      throw new Error(`unknown eval promote option: ${arg}`);
    }
  }
  if (!since) {
    throw new Error("usage: skillmux eval promote --since <window> [--target <path>] [--dry-run] [--yes] [--json]");
  }

  const config = await loadConfig();
  const stateDir = expandHome(config.state_dir);
  const targetPath = target ?? join(stateDir, "eval-observed.json");
  const sinceDate = parseSince(since);
  const sinceIso = sinceDate.toISOString();

  const candidates = await options.adapter.evalPromote(since);

  const existing = existsSync(targetPath) ? parseEvalCases(JSON.parse(readFileSync(targetPath, "utf-8"))) : [];
  const { cases: newCases, skipped } = excludeExistingCases(candidates, existing);

  console.error("warning: promoted eval cases contain raw user queries");

  if (dryRun) {
    emitSuccess(
      { isJson: options.isJson },
      { dry_run: true, since: sinceIso, target_path: targetPath, promoted: newCases.length, skipped_existing: skipped },
      () => console.log(`promote: would write ${newCases.length} case(s) to ${targetPath} (skipped_existing=${skipped})`),
    );
    return;
  }

  if (
    !(await confirmIfNeeded({
      confirmed: yes,
      isJson: options.isJson,
      prompt: `promote ${newCases.length} eval case(s) to ${targetPath}?`,
      nonInteractiveError: "skillmux eval promote requires --yes when run non-interactively",
    }))
  )
    return;

  if (newCases.length > 0) {
    writeFileSync(targetPath, JSON.stringify([...existing, ...newCases], null, 2) + "\n");
  }

  emitSuccess(
    { isJson: options.isJson },
    { dry_run: false, since: sinceIso, target_path: targetPath, promoted: newCases.length, skipped_existing: skipped },
    () => console.log(`promote: wrote ${newCases.length} case(s) to ${targetPath} (skipped_existing=${skipped})`),
  );
}
