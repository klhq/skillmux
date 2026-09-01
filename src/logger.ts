/**
 * Centralized structured-log helpers for degradation warnings.
 * Output format matches the hand-assembled JSON previously in router-core.ts:
 *   { level, stage, degraded_from, reason }
 * Written to stderr via console.error to preserve the existing wire format.
 */

export const log = {
  warn(stage: string, payload: Record<string, unknown>): void {
    console.error(JSON.stringify({ level: "warn", stage, ...payload }));
  },
  error(stage: string, payload: Record<string, unknown>): void {
    console.error(JSON.stringify({ level: "error", stage, ...payload }));
  },
};
