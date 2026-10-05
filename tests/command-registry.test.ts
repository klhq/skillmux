import { describe, expect, test } from "bun:test";
import { COMMAND_HELP } from "../src/command-help";
import { COMMANDS, KNOWN_COMMANDS, isDockerHostOnly } from "../src/command-registry";
import { generateCompletions } from "../src/completions";

const CLI = new URL("../src/cli.ts", import.meta.url).pathname;

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

describe("command registry", () => {
  test("command names are unique", () => {
    expect(new Set(KNOWN_COMMANDS).size).toBe(KNOWN_COMMANDS.length);
  });

  test("every command has help text and no help exists for an unregistered command", () => {
    for (const name of KNOWN_COMMANDS) expect(COMMAND_HELP[name]).toBeDefined();
    for (const name of Object.keys(COMMAND_HELP)) expect(KNOWN_COMMANDS).toContain(name);
  });

  test("every local-only command declares why", () => {
    for (const c of COMMANDS) {
      if (c.contextSupport === "local-only") expect(c.localOnlyReason).toBeDefined();
    }
  });

  test("every shell completes every command and subcommand", () => {
    for (const shell of ["bash", "zsh", "fish"] as const) {
      const script = generateCompletions(shell);
      for (const c of COMMANDS) {
        expect(script).toContain(c.name);
        if (c.subcommands) expect(script).toContain(c.subcommands.join(" "));
      }
    }
  });

  test("docker host-only policy keeps its subcommand exceptions", () => {
    expect(isDockerHostOnly("sync", "")).toBe(true);
    expect(isDockerHostOnly("eval", "")).toBe(true);
    expect(isDockerHostOnly("eval", "promote")).toBe(false);
    expect(isDockerHostOnly("config", "set")).toBe(true);
    expect(isDockerHostOnly("config", "show")).toBe(false);
    expect(isDockerHostOnly("doctor", "")).toBe(false);
  });
});

describe("CLI surface derived from the registry", () => {
  test("top-level help lists every command", async () => {
    const { stdout } = await run("--help");
    for (const name of KNOWN_COMMANDS) expect(stdout).toContain(name);
  });

  test("every command answers --help with its own text", async () => {
    for (const name of KNOWN_COMMANDS) {
      const { code, stdout } = await run(name, "--help");
      expect(code).toBe(0);
      expect(stdout).toBe(`${COMMAND_HELP[name]}\n`);
    }
  });

  test("an unrecognizable command points at --help and lists every command", async () => {
    const { code, stderr } = await run("bogus");
    expect(code).toBe(2);
    expect(stderr).toContain('Unknown command "bogus"');
    expect(stderr).toContain("skillmux --help");
    for (const name of KNOWN_COMMANDS) expect(stderr).toContain(name);
  });

  test("a near-miss still gets a suggestion", async () => {
    const { stderr } = await run("sycn");
    expect(stderr).toContain('Did you mean "sync"?');
  });
});
