import type { ResolvedContext } from "./context";

export interface JsonEnvelope<T = any> {
  schema_version: 1;
  ok: boolean;
  context: string | { name: string; server: string };
  /** @deprecated Slated for removal in the next major version. Use `context` instead. */
  target: string | { name: string; server: string };
  data: T | null;
  error: { code: string; message: string; details?: any } | null;
}

export function formatJsonEnvelope<T>(opts: {
  ok: boolean;
  /** @deprecated Slated for removal in the next major version. Use `context` instead. */
  target?: ResolvedContext | string | { name: string; server: string };
  context?: ResolvedContext | string | { name: string; server: string };
  data?: T;
  error?: { code: string; message: string; details?: any } | null;
}): JsonEnvelope<T> {
  const input: ResolvedContext | string | { name: string; server: string } =
    opts.context ?? opts.target ?? "local";
  let contextVal: string | { name: string; server: string };
  if (typeof input === "string") {
    contextVal = input;
  } else if (typeof input === "object" && input !== null) {
    if ("type" in input && (input as any).type === "local") {
      contextVal = "local";
    } else if ("name" in input && "server" in input) {
      contextVal = { name: input.name, server: input.server };
    } else {
      contextVal = "local";
    }
  } else {
    contextVal = "local";
  }

  return {
    schema_version: 1,
    ok: opts.ok,
    context: contextVal,
    target: contextVal,
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
  ctx: {
    isJson: boolean;
    /** @deprecated Slated for removal in the next major version. Use `context` instead. */
    target?: ResolvedContext | string | { name: string; server: string };
    context?: ResolvedContext | string | { name: string; server: string };
  },
  data: T,
  renderText: () => void,
): void {
  if (ctx.isJson) {
    const contextVal = ctx.context ?? ctx.target ?? "local";
    console.log(JSON.stringify(formatJsonEnvelope({ ok: true, context: contextVal, target: contextVal, data })));
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

/**
 * Builds the error for an unrecognized subcommand: "did you mean X" when
 * close to a valid one, otherwise the full <a|b|c> usage list — never a
 * fixed, possibly-unrelated usage string for just one of several valid
 * subcommands (that's what `config`'s fallback used to do before this
 * existed: any invalid subcommand got told "usage: skillmux config show",
 * silently omitting get/set/validate/diff/status/init).
 */
export function unknownSubcommandError(
  command: string,
  subCommand: string,
  validSubcommands: string[],
): Error {
  const suggestion = subCommand ? suggestCorrection(subCommand, validSubcommands) : null;
  if (suggestion) {
    return new Error(
      `Unknown "${command} ${subCommand}" subcommand. Did you mean "${command} ${suggestion}"?`,
    );
  }
  return new Error(`usage: skillmux ${command} <${validSubcommands.join("|")}>`);
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

export function renderContextBanner(context: ResolvedContext): void {
  if (!isInteractive()) return;
  if (context.type === "local") {
    console.log(`Context: local`);
  } else {
    console.log(`Context: remote (${context.name} -> ${context.server})`);
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
