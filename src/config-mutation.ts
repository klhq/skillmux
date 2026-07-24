import { writeFileSync, renameSync } from "node:fs";

export interface ThresholdsPatchOptions {
  matchScore: number;
  matchMargin: number;
  candidateFloor: number;
  runId: string;
}

/**
 * Remove a TOML section header and all lines until the next section header
 * (or end of file). Matches exact header string at start of line.
 */
export function removeSectionBlock(source: string, header: string): string {
  const lines = source.split("\n");
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const trimmed = line.trimEnd();
    if (trimmed === header || trimmed.startsWith(header + " ")) {
      skipping = true;
      continue;
    }
    if (skipping && line.trimStart().startsWith("[")) {
      skipping = false;
    }
    if (!skipping) out.push(line);
  }
  return out.join("\n");
}

/**
 * Surgically patch a TOML string to set [inference.thresholds] values and
 * [inference.calibration] run_id while preserving unrelated sections and comments.
 */
export function patchToml(
  source: string,
  opts: ThresholdsPatchOptions,
): string {
  const thresholdsBlock = `[inference.thresholds]\nmatch_score = ${opts.matchScore}\nmatch_margin = ${opts.matchMargin}\ncandidate_floor = ${opts.candidateFloor}\n`;
  const calibrationBlock = `[inference.calibration]\nrun_id = "${opts.runId}"\n`;

  // Remove any existing [inference.thresholds] and [inference.calibration] sections
  let result = removeSectionBlock(source, "[inference.thresholds]");
  result = removeSectionBlock(result, "[inference.calibration]");

  // Append both sections cleanly
  result = result.trimEnd() + "\n\n" + thresholdsBlock + "\n" + calibrationBlock;
  return result;
}

/**
 * Atomically write patched TOML to disk via temp file write and renameSync.
 */
export async function patchTomlFile(
  tomlPath: string,
  opts: ThresholdsPatchOptions,
): Promise<void> {
  const existing = await Bun.file(tomlPath).text();
  const patched = patchToml(existing, opts);

  const tmpPath = `${tomlPath}.${process.pid}.tmp`;
  writeFileSync(tmpPath, patched);
  renameSync(tmpPath, tomlPath);
}
