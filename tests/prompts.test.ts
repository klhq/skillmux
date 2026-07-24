import { describe, expect, test } from "bun:test";
import { parseCommaList, parseNumberSelection, shouldUseWizard } from "../src/prompts";

describe("parseNumberSelection", () => {
  test("accepts comma-separated choices, deduplicates them, and preserves option order", () => {
    expect(parseNumberSelection("3, 1, 3", 4)).toEqual([0, 2]);
  });
});

test("parseCommaList trims and deduplicates values", () => {
  expect(parseCommaList("sdd-tdd, code-context, sdd-tdd")).toEqual(["sdd-tdd", "code-context"]);
});

describe("shouldUseWizard", () => {
  test("starts only for an interactive command without declarative or machine-output flags", () => {
    expect(shouldUseWizard([], { interactive: true, json: false, dryRun: false })).toBe(true);
    expect(shouldUseWizard(["--client", "codex"], { interactive: true, json: false, dryRun: false })).toBe(false);
    expect(shouldUseWizard([], { interactive: false, json: false, dryRun: false })).toBe(false);
    expect(shouldUseWizard([], { interactive: true, json: true, dryRun: false })).toBe(false);
  });
});
