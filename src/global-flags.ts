export type GlobalFlag =
  | "--json"
  | "--allow-insecure"
  | "--verbose"
  | "--dry-run";

export type GlobalFlagWithValue = "--context" | "--server";

/**
 * Checks if an argument is a global flag that takes a value (e.g. `--context`, `--server`).
 * If an `allowed` list is provided, only flags in that subset are matched.
 */
export function isGlobalFlagWithValue(
  option: string | undefined,
  allowed?: readonly GlobalFlagWithValue[] | GlobalFlagWithValue,
  ...rest: GlobalFlagWithValue[]
): boolean {
  if (!option) return false;
  if (allowed !== undefined) {
    const list = Array.isArray(allowed) ? allowed : [allowed, ...rest];
    return list.includes(option as GlobalFlagWithValue);
  }
  return option === "--context" || option === "--server";
}

/**
 * Checks if an argument is a global flag that takes no value (e.g. `--json`, `--allow-insecure`, `--verbose`, `--dry-run`).
 * If an `allowed` list is provided, only flags in that subset are matched.
 */
export function isGlobalFlag(
  option: string | undefined,
  allowed?: readonly GlobalFlag[] | GlobalFlag,
  ...rest: GlobalFlag[]
): boolean {
  if (!option) return false;
  if (allowed !== undefined) {
    const list = Array.isArray(allowed) ? allowed : [allowed, ...rest];
    return list.includes(option as GlobalFlag);
  }
  return (
    option === "--json" ||
    option === "--allow-insecure" ||
    option === "--verbose" ||
    option === "--dry-run"
  );
}
