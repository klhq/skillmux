import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";

/**
 * Streams a prompt reads from and writes to. Injectable so prompts can be
 * tested without a terminal; defaults to the real process streams.
 */
export interface PromptIO {
  input?: Readable;
  output?: Writable;
}

export const NO_INPUT_ERROR = "no input available on stdin; re-run with --yes";

/**
 * Asks one question and resolves with the raw answer.
 *
 * `isInteractive()` only inspects stdout, so a caller can legitimately reach a
 * prompt while stdin is already at EOF (a pty'd stdout under CI, a wrapper
 * process, `skillmux init < /dev/null`). A bare `readline.question()` never
 * settles in that case and the CLI hangs forever, so the input stream ending
 * before an answer arrives is turned into an actionable error instead.
 *
 * Piped answers (`printf 'y\n' | skillmux ...`) still work: `close` only wins
 * the race when the stream ends with the question still outstanding.
 */
export async function askQuestion(query: string, io: PromptIO = {}): Promise<string> {
  const readline = createInterface({
    input: io.input ?? process.stdin,
    output: io.output ?? process.stdout,
  });
  let settled = false;
  try {
    return await new Promise<string>((resolve, reject) => {
      readline.question(query).then(
        (answer) => {
          settled = true;
          resolve(answer);
        },
        (error) => {
          settled = true;
          reject(error);
        },
      );
      // Fires on EOF, and also from the `finally` below. A piped stream ends
      // immediately after delivering its answer, so `close` can arrive before
      // the resolution microtask runs — deferring past pending microtasks lets
      // a real answer win the race, leaving only a genuine EOF to reject.
      readline.once("close", () => {
        setImmediate(() => {
          if (settled) return;
          settled = true;
          reject(new Error(NO_INPUT_ERROR));
        });
      });
    });
  } finally {
    readline.close();
  }
}

export interface SelectOption<T extends string> {
  value: T;
  label: string;
  detail?: string;
  selected?: boolean;
}

export function parseNumberSelection(input: string, optionCount: number): number[] {
  if (input.trim() === "") return [];
  const indexes = input.split(",").map((part) => {
    const choice = Number(part.trim());
    if (!Number.isInteger(choice) || choice < 1 || choice > optionCount) {
      throw new Error(`select numbers between 1 and ${optionCount}, separated by commas`);
    }
    return choice - 1;
  });
  return [...new Set(indexes)].sort((a, b) => a - b);
}

export function parseCommaList(input: string): string[] {
  return [...new Set(input.split(",").map((value) => value.trim()).filter(Boolean))];
}

export function shouldUseWizard(
  args: readonly string[],
  mode: { interactive: boolean; json: boolean; dryRun: boolean },
): boolean {
  if (!mode.interactive || mode.json || mode.dryRun || args.includes("--yes")) return false;
  if (args.includes("--interactive")) return true;
  return args.length === 0;
}

export async function promptMultiSelect<T extends string>(
  question: string,
  options: readonly SelectOption<T>[],
  io: PromptIO = {},
): Promise<T[]> {
  const output = io.output ?? process.stdout;
  output.write(`\n${question}\n`);
  options.forEach((option, index) => {
    const checked = option.selected ? "x" : " ";
    const detail = option.detail ? `  ${option.detail}` : "";
    output.write(`  ${index + 1}. [${checked}] ${option.label}${detail}\n`);
  });
  const defaults = options
    .map((option, index) => option.selected ? String(index + 1) : "")
    .filter(Boolean)
    .join(",");
  const suffix = defaults ? ` [${defaults}]` : "";
  const answer = await askQuestion(`Select numbers, comma-separated${suffix}: `, io);
  const selection = answer.trim() === "" && defaults ? defaults : answer;
  return parseNumberSelection(selection, options.length).map((index) => options[index]!.value);
}

export async function promptText(
  question: string,
  defaultValue = "",
  io: PromptIO = {},
): Promise<string> {
  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  const answer = (await askQuestion(`${question}${suffix}: `, io)).trim();
  return answer || defaultValue;
}
