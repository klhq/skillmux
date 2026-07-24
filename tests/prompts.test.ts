import { describe, expect, test } from "bun:test";
import { parseNumberSelection } from "../src/prompts";

describe("parseNumberSelection", () => {
  test("accepts comma-separated choices, deduplicates them, and preserves option order", () => {
    expect(parseNumberSelection("3, 1, 3", 4)).toEqual([0, 2]);
  });
});
