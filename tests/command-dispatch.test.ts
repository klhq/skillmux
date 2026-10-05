import { describe, expect, test } from "bun:test";
import { KNOWN_COMMANDS } from "../src/command-registry";

/**
 * Commands that main() still recognizes only to tell the user they were
 * removed or renamed. They are deliberately absent from the registry, so they
 * have no help, completion, or context classification.
 */
const REMOVED_COMMANDS = ["calibrate", "which", "manifest", "target"];

async function dispatchCases(): Promise<string[]> {
  const source = await Bun.file(new URL("../src/cli.ts", import.meta.url)).text();
  const start = source.indexOf("switch (command) {");
  const end = source.indexOf("default: {", start);
  if (start === -1 || end === -1) {
    throw new Error("could not find main()'s `switch (command)` in src/cli.ts; update this test");
  }
  return [...source.slice(start, end).matchAll(/^\s*case "([a-z-]+)":/gm)].map((m) => m[1]!);
}

describe("registry and dispatch stay in sync", () => {
  test("every registered command has a case in main()'s dispatch switch", async () => {
    const cases = await dispatchCases();
    const unhandled = KNOWN_COMMANDS.filter((name) => !cases.includes(name));
    expect(unhandled).toEqual([]);
  });

  test("every dispatch case is either registered or a known removed command", async () => {
    const cases = await dispatchCases();
    const unregistered = cases.filter(
      (name) => !KNOWN_COMMANDS.includes(name) && !REMOVED_COMMANDS.includes(name),
    );
    expect(unregistered).toEqual([]);
  });

  test("removed commands are not registered", () => {
    for (const name of REMOVED_COMMANDS) expect(KNOWN_COMMANDS).not.toContain(name);
  });

  test("the check itself sees the dispatch switch", async () => {
    const cases = await dispatchCases();
    expect(cases.length).toBeGreaterThanOrEqual(KNOWN_COMMANDS.length);
  });
});
