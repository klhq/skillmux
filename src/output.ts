import type { ResolvedContext } from "./context";

export interface JsonEnvelope<T = any> {
  schema_version: 1;
  ok: boolean;
  target: string | { name: string; server: string };
  data: T | null;
  error: { code: string; message: string; details?: any } | null;
}

export function formatJsonEnvelope<T>(opts: {
  ok: boolean;
  target: ResolvedContext | string | { name: string; server: string };
  data?: T;
  error?: { code: string; message: string; details?: any } | null;
}): JsonEnvelope<T> {
  let targetVal: string | { name: string; server: string };
  if (typeof opts.target === "string" || (typeof opts.target === "object" && "server" in opts.target && !("type" in opts.target))) {
    targetVal = opts.target as any;
  } else if (typeof opts.target === "object" && "type" in opts.target) {
    if (opts.target.type === "local") {
      targetVal = "local";
    } else {
      targetVal = { name: opts.target.name, server: opts.target.server };
    }
  } else {
    targetVal = "local";
  }

  return {
    schema_version: 1,
    ok: opts.ok,
    target: targetVal,
    data: opts.data ?? null,
    error: opts.error ?? null,
  };
}

export class CliError extends Error {
  exitCode: number;
  code: string;
  details?: unknown;

  constructor(message: string, exitCode: number, code = `EXIT_${exitCode}`, details?: unknown) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
    this.code = code;
    this.details = details;
  }
}

export function emitSuccess<T>(
  ctx: { isJson: boolean; target?: ResolvedContext | string | { name: string; server: string } },
  data: T,
  renderText: () => void,
): void {
  if (ctx.isJson) {
    console.log(JSON.stringify(formatJsonEnvelope({ ok: true, target: ctx.target ?? "local", data })));
  } else {
    renderText();
  }
}

export function mapExitCode(err: unknown): number {
  if (!err) return 0;
  if (err instanceof CliError) return err.exitCode;
  return 2;
}

export function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) {
    if (!dp[i]) dp[i] = [];
    dp[i]![0] = i;
  }
  for (let j = 0; j <= n; j++) {
    if (!dp[0]) dp[0] = [];
    dp[0]![j] = j;
  }

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const prevRow = dp[i - 1]!;
      const curRow = dp[i]!;
      curRow[j] = Math.min(
        prevRow[j]! + 1,
        curRow[j - 1]! + 1,
        prevRow[j - 1]! + cost
      );
    }
  }
  return dp[m]![n]!;
}

export function suggestCorrection(input: string, candidates: string[]): string | null {
  let minDistance = Infinity;
  let bestMatch: string | null = null;

  for (const candidate of candidates) {
    const dist = levenshteinDistance(input, candidate);
    if (dist < minDistance && dist <= 2) {
      minDistance = dist;
      bestMatch = candidate;
    }
  }

  return bestMatch;
}

export function isInteractive(
  env: NodeJS.ProcessEnv = process.env,
  stdoutIsTTY = process.stdout.isTTY,
): boolean {
  return stdoutIsTTY === true && env.TERM !== "dumb";
}

/** Color is opt-out only: https://no-color.org, plus the same TTY check as isInteractive(). */
export function isColorEnabled(
  env: NodeJS.ProcessEnv = process.env,
  stdoutIsTTY = process.stdout.isTTY,
): boolean {
  if (env.NO_COLOR !== undefined) return false;
  return isInteractive(env, stdoutIsTTY);
}

const ANSI = { reset: "\x1b[0m", bold: "\x1b[1m", red: "\x1b[31m", yellow: "\x1b[33m", green: "\x1b[32m" } as const;

function paint(code: string, text: string): string {
  return isColorEnabled() ? `${code}${text}${ANSI.reset}` : text;
}

export const red = (text: string): string => paint(ANSI.red, text);
export const yellow = (text: string): string => paint(ANSI.yellow, text);
export const green = (text: string): string => paint(ANSI.green, text);
export const bold = (text: string): string => paint(ANSI.bold, text);

/** Prints a "warning: <line>" message to stderr, colored yellow when color is enabled. */
export function warn(line: string): void {
  console.error(yellow(`warning: ${line}`));
}

export function renderTargetBanner(target: ResolvedContext): void {
  if (!isInteractive()) return;
  if (target.type === "local") {
    console.log(`Target: local`);
  } else {
    console.log(`Target: remote (${target.name} -> ${target.server})`);
  }
}

export function renderTable(columns: { key: string; header: string }[], rows: Record<string, any>[]): void {
  if (rows.length === 0) {
    console.log("(no entries)");
    return;
  }

  const widths = new Map<string, number>();
  for (const col of columns) {
    const maxLen = Math.max(col.header.length, ...rows.map((r) => String(r[col.key] ?? "").length));
    widths.set(col.key, maxLen);
  }

  const headerLine = columns.map((col) => col.header.padEnd(widths.get(col.key) ?? 0)).join("  ");
  const sepLine = columns.map((col) => "-".repeat(widths.get(col.key) ?? 0)).join("  ");

  console.log(bold(headerLine));
  console.log(sepLine);
  for (const row of rows) {
    const line = columns.map((col) => String(row[col.key] ?? "").padEnd(widths.get(col.key) ?? 0)).join("  ");
    console.log(line);
  }
}
