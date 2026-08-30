import { describe, expect, test } from "bun:test";
import { safeTokenEquals } from "../src/server";

describe("safeTokenEquals (SMX-94)", () => {
  test("returns true for equal tokens", () => {
    expect(safeTokenEquals("secret-token-123", "secret-token-123")).toBe(true);
  });

  test("returns false for different tokens of the same length", () => {
    expect(safeTokenEquals("secret-token-123", "secret-token-124")).toBe(false);
  });

  test("returns false for tokens of different lengths", () => {
    expect(safeTokenEquals("short", "a-much-longer-token-value")).toBe(false);
  });

  test("returns true for two empty strings", () => {
    expect(safeTokenEquals("", "")).toBe(true);
  });

  test("returns false when only one token is empty", () => {
    expect(safeTokenEquals("", "nonempty")).toBe(false);
  });
});
