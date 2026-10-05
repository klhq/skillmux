import { describe, expect, test } from "bun:test";
import {
  HANDLERS,
  REMOVED_COMMANDS,
  findHandler,
  type CommandHandler,
} from "../src/command-handlers";
import { KNOWN_COMMANDS, type CommandName } from "../src/command-registry";

const CLI = new URL("../src/cli.ts", import.meta.url).pathname;

async function run(...args: string[]) {
  const proc = Bun.spawn(["bun", CLI, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: { ...process.env, RUNNING_IN_DOCKER: "" },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stdout, stderr };
}

describe("registry and handlers stay in sync", () => {
  test("every registered command has a handler, and no handler is unregistered", () => {
    expect(Object.keys(HANDLERS).sort()).toEqual([...KNOWN_COMMANDS].sort());
  });

  test("a removed command is not also registered", () => {
    for (const name of Object.keys(REMOVED_COMMANDS)) expect(KNOWN_COMMANDS).not.toContain(name);
  });

  // This is what makes the table safe to extend: tsc (run in CI) rejects a
  // handler table that is missing a registered command or has an unregistered
  // one. The directives below fail the build if that stops being true.
  test("the table is checked for exhaustiveness at compile time", () => {
    const noop: CommandHandler = async () => {};

    // @ts-expect-error a registered command without a handler must not compile
    const missing: Record<CommandName, CommandHandler> = { ...HANDLERS, doctor: undefined };

    const unregistered: Record<CommandName, CommandHandler> = {
      ...HANDLERS,
      // @ts-expect-error a handler for an unregistered command must not compile
      "not-a-command": noop,
    };

    expect(missing).toBeDefined();
    expect(unregistered).toBeDefined();
  });
});

describe("findHandler", () => {
  test("finds each registered command", () => {
    for (const name of KNOWN_COMMANDS) expect(findHandler(name)).toBeFunction();
  });

  test("does not mistake an inherited property for a command", () => {
    for (const name of ["constructor", "toString", "hasOwnProperty", "__proto__", "valueOf"]) {
      expect(findHandler(name)).toBeUndefined();
    }
  });

  test("returns nothing for an unknown or removed command", () => {
    expect(findHandler("bogus")).toBeUndefined();
    for (const name of Object.keys(REMOVED_COMMANDS)) expect(findHandler(name)).toBeUndefined();
  });
});

describe("CLI dispatch", () => {
  test("a name that exists on Object.prototype is an unknown command, not a crash", async () => {
    for (const name of ["constructor", "toString", "__proto__"]) {
      const { code, stderr } = await run(name);
      expect(code).toBe(2);
      expect(stderr).toContain(`Unknown command "${name}"`);
    }
  });

  test("removed commands say what replaced them", async () => {
    expect((await run("calibrate")).stderr).toContain('use "skillmux eval"');
    expect((await run("which", "my-skill")).stderr).toContain('"skillmux skill which my-skill"');
    expect((await run("manifest", "pin")).stderr).toContain('"skillmux core pin"');
    expect((await run("target")).stderr).toContain('replaced by "skillmux agent"');
  });

  test("a near-miss is still suggested", async () => {
    expect((await run("sycn")).stderr).toContain('Did you mean "sync"?');
  });

  test("registered commands reach their handler", async () => {
    const eval_ = await run("eval", "bogus");
    expect(eval_.stderr).toContain('unknown eval subcommand "bogus"');
    const models = await run("models", "bogus");
    expect(models.stderr).toContain('unknown models subcommand "bogus"');
    const completions = await run("completions");
    expect(completions.stderr).toContain("missing <shell> argument");
  });
});
