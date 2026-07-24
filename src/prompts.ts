import { createInterface } from "node:readline/promises";

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
): Promise<T[]> {
  console.log(`\n${question}`);
  options.forEach((option, index) => {
    const checked = option.selected ? "x" : " ";
    const detail = option.detail ? `  ${option.detail}` : "";
    console.log(`  ${index + 1}. [${checked}] ${option.label}${detail}`);
  });
  const defaults = options
    .map((option, index) => option.selected ? String(index + 1) : "")
    .filter(Boolean)
    .join(",");
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const suffix = defaults ? ` [${defaults}]` : "";
    const answer = await readline.question(`Select numbers, comma-separated${suffix}: `);
    const selection = answer.trim() === "" && defaults ? defaults : answer;
    return parseNumberSelection(selection, options.length).map((index) => options[index]!.value);
  } finally {
    readline.close();
  }
}
