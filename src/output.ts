import { format } from "node:util";
import type { ResolvedContext } from "./context";

export interface JsonEnvelope<T = any> {
  schema_version: 1;
  ok: boolean;
  context: string | { name: string; server: string };
  /** @deprecated Use `context` instead. Retained as a compatibility alias; no removal planned. */
  target: string | { name: string; server: string };
  data: T | null;
  error: { code: string; message: string; details?: any } | null;
}

export function formatJsonEnvelope<T>(opts: {
  ok: boolean;
  /** @deprecated Use `context` instead. Retained as a compatibility alias; no removal planned. */
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
    /** @deprecated Use `context` instead. Retained as a compatibility alias; no removal planned. */
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

export function suggestCorrection(input: string, candidates: readonly string[]): string | null {
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

let colorDisabled = false;

/** Turns off color from this module's own helpers (red, green, bold, ...). */
export function setColorDisabled(disabled: boolean): void {
  colorDisabled = disabled;
}

/**
 * Bun wraps console.error output in red on a TTY by itself, and only honors
 * NO_COLOR from the environment at startup, so setting it in-process does
 * nothing. Writing through process.stderr.write bypasses that. main() always
 * does this, so the only color on stderr is color this module chose (a red
 * label, not a red paragraph), and --no-color can actually turn it off.
 *
 * Returns a function that restores the previous console.error.
 */
export function routeStderrUncolored(): () => void {
  const original = console.error;
  console.error = (...args: unknown[]) => {
    process.stderr.write(`${format(...args)}\n`);
  };
  return () => {
    console.error = original;
  };
}

/**
 * Color is opt-out only: the --no-color flag, https://no-color.org, or a
 * non-interactive stdout (the same TTY check as isInteractive()).
 */
export function isColorEnabled(
  env: NodeJS.ProcessEnv = process.env,
  stdoutIsTTY = process.stdout.isTTY,
): boolean {
  if (colorDisabled) return false;
  if (env.NO_COLOR !== undefined) return false;
  return isInteractive(env, stdoutIsTTY);
}

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  boldRed: "\x1b[1;31m",
  boldYellow: "\x1b[1;33m",
} as const;

/** Color is decided per stream: stdout text checks stdout, error text checks stderr. */
export type ColorStream = "stdout" | "stderr";

function colorOn(stream: ColorStream): boolean {
  // Coerce: an undefined isTTY (a redirected stream) would otherwise hit
  // isColorEnabled's default parameter and silently borrow stdout's value.
  return isColorEnabled(process.env, (stream === "stderr" ? process.stderr : process.stdout).isTTY === true);
}

function paint(code: string, text: string, stream: ColorStream): string {
  return colorOn(stream) ? `${code}${text}${ANSI.reset}` : text;
}

/*
 * Color marks a label or a status, never a whole sentence, and the words
 * always carry the meaning on their own (color is redundant, so it can be off
 * without losing anything): red is failure, yellow is attention, green is
 * success, cyan is an informational label, dim is secondary, bold is a heading.
 */
export const red = (text: string, stream: ColorStream = "stdout"): string => paint(ANSI.red, text, stream);
export const yellow = (text: string, stream: ColorStream = "stdout"): string => paint(ANSI.yellow, text, stream);
export const green = (text: string, stream: ColorStream = "stdout"): string => paint(ANSI.green, text, stream);
export const cyan = (text: string, stream: ColorStream = "stdout"): string => paint(ANSI.cyan, text, stream);
export const dim = (text: string, stream: ColorStream = "stdout"): string => paint(ANSI.dim, text, stream);
export const bold = (text: string, stream: ColorStream = "stdout"): string => paint(ANSI.bold, text, stream);
export const boldRed = (text: string, stream: ColorStream = "stdout"): string => paint(ANSI.boldRed, text, stream);

/** Prints a "warning: <line>" message to stderr with only the label colored. */
export function warn(line: string): void {
  console.error(`${paint(ANSI.boldYellow, "warning:", "stderr")} ${line}`);
}

/**
 * The marker appended to every line that describes what --dry-run would do
 * instead of doing it. One shape everywhere (a trailing "(dry-run)"), colored
 * as an informational label.
 */
export function dryRunTag(): string {
  return cyan("(dry-run)");
}

/** Prints a "note: <line>" message to stderr: informational, not a problem. */
export function note(line: string): void {
  console.error(`${paint(ANSI.cyan, "note:", "stderr")} ${line}`);
}

/**
 * Formats an error for stderr: a bold red "error:" label, then the message as
 * written. A message that already starts with "error:" is not labeled twice,
 * and one that starts with "usage:" is a usage line, which is not an error
 * label's job. Any later line starting with "usage:" gets a bold label too.
 */
export function renderError(message: string): string {
  const stderrBold = (text: string) => paint(ANSI.bold, text, "stderr");
  const lines = message.split("\n").map((line, index) => {
    if (line.startsWith("usage:")) return `${stderrBold("usage:")}${line.slice("usage:".length)}`;
    if (index > 0) return line;
    const body = line.startsWith("error:") ? line.slice("error:".length).trimStart() : line;
    return `${paint(ANSI.boldRed, "error:", "stderr")} ${body}`;
  });
  return lines.join("\n");
}

/**
 * Styles help text for a terminal: command names and section headings
 * ("usage:", "Setup:", "Commands:") in bold. Plain text when color is off.
 */
export function styleHelp(text: string): string {
  return text
    .split("\n")
    .map((line, index) => {
      const heading = line.match(/^([A-Za-z][A-Za-z ]*:)$/);
      if (heading) return bold(heading[1]!);
      const usage = line.match(/^(usage:)( .*)$/);
      if (usage) return `${bold(usage[1]!)}${usage[2]}`;
      const name = index === 0 ? line.match(/^([a-z][a-z-]*:)( .*)$/) : null;
      if (name) return `${bold(name[1]!)}${name[2]}`;
      return line;
    })
    .join("\n");
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
