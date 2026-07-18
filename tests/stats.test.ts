import { describe, expect, test } from "bun:test";
import { parseSince } from "../src/stats";

describe("parseSince", () => {
  test("parses a relative days window into a Date offset from now", () => {
    const now = new Date("2026-07-19T00:00:00.000Z");

    const result = parseSince("30d", now);

    expect(result.toISOString()).toBe("2026-06-19T00:00:00.000Z");
  });

  test("parses a relative hours window", () => {
    const now = new Date("2026-07-19T12:00:00.000Z");

    expect(parseSince("6h", now).toISOString()).toBe("2026-07-19T06:00:00.000Z");
  });

  test("parses an absolute ISO date unchanged, ignoring now", () => {
    const now = new Date("2026-07-19T00:00:00.000Z");

    expect(parseSince("2026-01-01", now).toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  test("throws on a malformed since string", () => {
    expect(() => parseSince("not-a-window")).toThrow("invalid --since window: not-a-window");
  });
});
