/**
 * Centralized logging helpers, all writing to stderr via console.error.
 * `log` emits structured JSON ({ level, stage, ...payload }) for machine-
 * readable signals like router-core's retrieval-degradation warnings.
 * `redactedErrorLog` builds a plain-text [prefix, message] pair for
 * operator-facing runtime errors that need secret redaction.
 */

export const log = {
  warn(stage: string, payload: Record<string, unknown>): void {
    console.error(JSON.stringify({ level: "warn", stage, ...payload }));
  },
  error(stage: string, payload: Record<string, unknown>): void {
    console.error(JSON.stringify({ level: "error", stage, ...payload }));
  },
};

/** Pairs a fixed log prefix with a redacted error message, for console.error. */
export function redactedErrorLog(
  prefix: string,
  err: unknown,
  redact: (text: string) => string,
): [string, string] {
  const msg = err instanceof Error ? err.message : String(err);
  return [prefix, redact(msg)];
}
