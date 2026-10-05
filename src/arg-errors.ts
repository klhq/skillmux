import { documentedFlags } from "./command-help";
import { CliError, suggestCorrection } from "./output";

/** Flags every command accepts, so they are valid "did you mean" targets everywhere. */
const GLOBAL_FLAGS = ["--json", "--verbose", "--dry-run", "--allow-insecure", "--no-color", "--context", "--server"];

/**
 * A bad or missing argument: says what is wrong, then shows the usage line.
 * Exit code 2, JSON code USAGE_ERROR. `usage` may omit its "usage: " prefix.
 */
export function usageError(problem: string, usage: string): CliError {
  const usageLine = usage.startsWith("usage:") ? usage : `usage: ${usage}`;
  return new CliError(`${problem}\n${usageLine}`, 2, "USAGE_ERROR", { usage: usageLine });
}

/**
 * An option the command does not accept. Suggests the closest flag the command
 * documents in its own help text, so there is no separate flag list to keep in
 * sync. `label` is the command as the user typed it ("eval promote"); its first
 * word selects the help text.
 */
export function unknownOptionError(label: string, option: string | undefined): CliError {
  const command = label.split(" ")[0]!;
  const candidates = [...new Set([...documentedFlags(command), ...GLOBAL_FLAGS])];
  const suggestion = option ? suggestCorrection(option, candidates) : null;
  const hint = suggestion ? `. Did you mean ${suggestion}?` : "";
  return new CliError(
    `unknown ${label} option: ${option}${hint}\nRun "skillmux ${command} --help" for usage.`,
    2,
    "USAGE_ERROR",
    { option, ...(suggestion ? { suggestion } : {}) },
  );
}
