import { describe, expect, test } from "bun:test";
import { unknownOptionError, usageError } from "../src/arg-errors";

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

describe("usageError", () => {
  test("puts the problem before the usage line and exits 2", () => {
    const err = usageError("missing <key> argument", "usage: skillmux config get <key>");
    expect(err.message).toBe("missing <key> argument\nusage: skillmux config get <key>");
    expect(err.exitCode).toBe(2);
    expect(err.code).toBe("USAGE_ERROR");
  });

  test("adds the usage prefix when the caller omits it", () => {
    expect(usageError("bad", "skillmux x").message).toBe("bad\nusage: skillmux x");
  });
});

describe("unknownOptionError", () => {
  test("suggests the closest flag the command documents", () => {
    const err = unknownOptionError("update", "--yess");
    expect(err.message).toContain("unknown update option: --yess. Did you mean --yes?");
    expect(err.message).toContain('Run "skillmux update --help" for usage.');
    expect(err.details).toEqual({ option: "--yess", suggestion: "--yes" });
  });

  test("suggests a global flag for any command", () => {
    expect(unknownOptionError("scan", "--jsno").message).toContain("Did you mean --json?");
  });

  test("uses the first word of a two-word label to find help", () => {
    const err = unknownOptionError("eval promote", "--sinse");
    expect(err.message).toContain("unknown eval promote option: --sinse. Did you mean --since?");
    expect(err.message).toContain('"skillmux eval --help"');
  });

  test("omits the hint when nothing is close", () => {
    const err = unknownOptionError("scan", "--zzzzzzzz");
    expect(err.message).toStartWith("unknown scan option: --zzzzzzzz\n");
    expect(err.details).toEqual({ option: "--zzzzzzzz" });
  });
});

describe("CLI argument errors", () => {
  const missing: [string[], string, string][] = [
    [["install"], "missing <repo> argument", "usage: skillmux install"],
    [["report"], "missing required option --since <window>", "usage: skillmux report"],
    [["core", "pin"], "missing <skill_id> argument", "usage: skillmux core pin"],
    [["agent", "add"], "missing <agent> argument", "usage: skillmux agent add"],
    [["config", "get"], "missing <key> argument", "usage: skillmux config get"],
    [["context", "use"], "missing <name> argument", "usage: skillmux context use"],
    [["project", "show"], "missing <group> argument", "usage: skillmux project show"],
    [["eval", "promote"], "missing required option --since <window>", "usage: skillmux eval promote"],
    [["audit"], "missing subcommand", "usage: skillmux audit prune"],
    [["models"], "missing subcommand", "usage: skillmux models download"],
    [["completions"], "missing <shell> argument", "usage: skillmux completions"],
  ];

  for (const [args, problem, usage] of missing) {
    test(`${args.join(" ")} names what is missing, then shows usage`, async () => {
      const { code, stderr } = await run(...args);
      expect(code).toBe(2);
      const lines = stderr.trim().split("\n");
      expect(lines[0]).toBe(`error: ${problem}`);
      expect(lines[1]).toStartWith(usage);
    });
  }

  test("a mistyped option gets a suggestion and a help pointer", async () => {
    const { code, stderr } = await run("sync", "--dryrun");
    expect(code).toBe(2);
    expect(stderr).toContain("unknown sync option: --dryrun. Did you mean --dry-run?");
    expect(stderr).toContain('Run "skillmux sync --help" for usage.');
  });

  test("--json reports USAGE_ERROR with the usage line in details", async () => {
    const { code, stdout } = await run("install", "--json");
    expect(code).toBe(2);
    const env = JSON.parse(stdout);
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe("USAGE_ERROR");
    expect(env.error.details.usage).toStartWith("usage: skillmux install");
    expect(env.error.message).toStartWith("missing <repo> argument\n");
  });
});
