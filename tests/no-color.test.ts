import { afterEach, describe, expect, test } from "bun:test";
import { unknownOptionError } from "../src/arg-errors";
import { generateCompletions } from "../src/completions";
import { isColorEnabled, red, routeStderrUncolored, setColorDisabled } from "../src/output";
import { ansiCount, python, runOnPty } from "./helpers/pty";

const CLI = new URL("../src/cli.ts", import.meta.url).pathname;
const TTY_ENV = { TERM: "xterm-256color" };

async function run(...args: string[]) {
  const proc = Bun.spawn(["bun", CLI, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, RUNNING_IN_DOCKER: "" },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stdout, stderr };
}

afterEach(() => setColorDisabled(false));

describe("color state", () => {
  test("is on for an interactive TTY by default", () => {
    expect(isColorEnabled(TTY_ENV, true)).toBe(true);
  });

  test("setColorDisabled turns it off even on a TTY", () => {
    setColorDisabled(true);
    expect(isColorEnabled(TTY_ENV, true)).toBe(false);
  });

  test("setColorDisabled(false) restores the default", () => {
    setColorDisabled(true);
    setColorDisabled(false);
    expect(isColorEnabled(TTY_ENV, true)).toBe(true);
  });

  test("helpers return plain text once color is disabled", () => {
    setColorDisabled(true);
    expect(red("boom")).toBe("boom");
  });
});

describe("routeStderrUncolored", () => {
  test("sends console.error through process.stderr.write and can be undone", () => {
    const originalError = console.error;
    const originalWrite = process.stderr.write;
    const written: string[] = [];
    process.stderr.write = ((chunk: string) => {
      written.push(chunk);
      return true;
    }) as typeof process.stderr.write;
    const restore = routeStderrUncolored();
    try {
      console.error("bad %s", "thing", 42);
      expect(written).toEqual(["bad thing 42\n"]);
    } finally {
      restore();
      process.stderr.write = originalWrite;
    }
    expect(console.error).toBe(originalError);
  });
});

describe("--no-color flag", () => {
  test("is accepted by commands that reject unknown options, before or after the command", async () => {
    const after = await run("install", "--no-color");
    expect(after.stderr).toContain("missing <repo> argument");
    expect(after.stderr).not.toContain("unknown install option");

    const before = await run("--no-color", "install");
    expect(before.stderr).toContain("missing <repo> argument");
  });

  test("is not mistaken for the command", async () => {
    const { code, stdout } = await run("--no-color", "--help");
    expect(code).toBe(0);
    expect(stdout).toContain("--no-color");
  });

  test("is offered by bash completions and as an option suggestion", () => {
    // bash lists global flags once at the top level; zsh and fish only script per-command flags
    expect(generateCompletions("bash")).toContain("--no-color");
    expect(unknownOptionError("scan", "--no-colour").message).toContain("Did you mean --no-color?");
  });

  // Bun colors console.error red on a TTY by itself and ignores in-process NO_COLOR,
  // so this has to run under a real pty to catch a regression.
  (python ? test : test.skip)("leaves no ANSI codes anywhere on a TTY", async () => {
    for (const args of [["bogus"], ["install"], ["scan", "--help"], ["agent", "list"]]) {
      const colored = await runOnPty(args);
      const plain = await runOnPty([...args, "--no-color"]);
      expect(ansiCount(plain.tty)).toBe(0);
      // the unflagged run proves the pty actually enables color for this command
      if (args[0] === "bogus" || args[0] === "install") expect(ansiCount(colored.tty)).toBeGreaterThan(0);
    }
  });
});
