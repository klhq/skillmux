import { expandHome, loadConfig } from "../config";
import { emitSuccess, warn } from "../output";
import {
  parseFailOn,
  renderScanJson,
  renderScanText,
  scanExitCode,
  scanPath,
  type ScanSeverity,
} from "../scan";
import { isGlobalFlag } from "../global-flags";

function parseScanArgs(args: string[]): {
  path?: string;
  format: "text" | "json";
  formatExplicit: boolean;
  failOn?: ScanSeverity;
} {
  let path: string | undefined;
  let format: "text" | "json" = "text";
  let formatExplicit = false;
  let failOn: ScanSeverity | undefined;
  for (let i = 0; i < args.length; i++) {
    const option = args[i];
    if (option === "--format") {
      const value = args[++i];
      if (value !== "text" && value !== "json")
        throw new Error("--format must be text or json");
      format = value;
      formatExplicit = true;
    } else if (option === "--fail-on") {
      // scan accepts "none" for symmetry with install/update, where it is the
      // opt-out. Here it is already the default: scan reports, and the caller
      // opts into a non-zero exit code.
      const parsed = parseFailOn(args[++i]);
      failOn = parsed === "none" ? undefined : parsed;
    } else if (isGlobalFlag(option, "--json")) {
      // handled globally by main()'s isJson flag; recognized here so it isn't rejected
    } else if (option?.startsWith("--")) {
      throw new Error(`unknown scan option: ${option}`);
    } else if (path !== undefined) {
      throw new Error("skillmux scan accepts at most one <path> argument");
    } else {
      path = option;
    }
  }
  return { path, format, formatExplicit, failOn };
}

export async function runScan(
  args: string[],
  options: { isJson: boolean },
): Promise<void> {
  const { path, format, formatExplicit, failOn } = parseScanArgs(args);
  if (formatExplicit) {
    // --format predates the shared --json envelope and is the last command
    // flag that emits JSON outside it. Kept working for existing callers;
    // the warning goes to stderr so stdout stays machine-parseable.
    warn("--format is deprecated and will be removed in the next major version; use --json instead");
  }
  const rootPath = path
    ? expandHome(path)
    : expandHome((await loadConfig()).vault_path);
  const result = await scanPath(rootPath);
  emitSuccess({ isJson: options.isJson }, result, () => {
    console.log(
      format === "json" ? renderScanJson(result) : renderScanText(result),
    );
  });
  process.exitCode = scanExitCode(result.findings, failOn);
}
