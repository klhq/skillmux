import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unknownOptionError } from "../src/arg-errors";
import { helpUsage } from "../src/command-help";
import { suggestCorrection, transpositionDistance } from "../src/output";

const CLI = new URL("../src/cli.ts", import.meta.url).pathname;

/** Runs the CLI in an empty home with no config and no stdin, like a fresh machine in a script. */
async function init(...args: string[]) {
  const home = mkdtempSync(join(tmpdir(), "skillmux-init-"));
  const proc = Bun.spawn(["bun", CLI, "init", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: { PATH: process.env.PATH!, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_STATE_HOME: join(home, ".state") },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stdout, stderr, home };
}

describe("transpositionDistance", () => {
  test("counts a swap of adjacent characters as one edit", () => {
    expect(transpositionDistance("sycn", "sync")).toBe(1);
    expect(transpositionDistance("whcih", "which")).toBe(1);
    expect(transpositionDistance("--jsno", "--json")).toBe(1);
  });

  test("still counts insertions, deletions, and substitutions", () => {
    expect(transpositionDistance("lst", "list")).toBe(1);
    expect(transpositionDistance("scope", "core")).toBe(2);
    expect(transpositionDistance("same", "same")).toBe(0);
  });
});

describe("suggestCorrection cutoff", () => {
  test("a short name tolerates one edit, so a different word is not offered as a typo fix", () => {
    expect(suggestCorrection("--scope", ["--core", "--vault", "--agent"])).toBeNull();
    expect(suggestCorrection("scope", ["core"])).toBeNull();
  });

  test("dashes do not count toward a name's length", () => {
    expect(suggestCorrection("--yess", ["--yes"])).toBe("--yes");
    expect(suggestCorrection("--sinse", ["--since"])).toBe("--since");
  });

  test("a longer name tolerates two edits", () => {
    expect(suggestCorrection("cntxt", ["context", "config"])).toBe("context");
  });

  test("transposed letters are suggested even in a short name", () => {
    expect(suggestCorrection("sycn", ["sync", "init"])).toBe("sync");
  });
});

describe("init option redirects", () => {
  test("flags that belong to project init point there instead of suggesting a near match", () => {
    for (const flag of ["--scope", "--project", "--path"]) {
      const err = unknownOptionError("init", flag);
      expect(err.message).toContain(`unknown init option: ${flag}.`);
      expect(err.message).toContain('"skillmux project init [path]"');
      expect(err.message).not.toContain("Did you mean");
      expect(err.details).toMatchObject({ option: flag });
    }
  });

  test("the redirect is specific to init", () => {
    expect(unknownOptionError("sync", "--scope").message).not.toContain("project init");
  });
});

describe("helpUsage", () => {
  test("returns the usage block from the help text and stops at the blank line", () => {
    const usage = helpUsage("init");
    expect(usage).toStartWith("usage:\n  skillmux init [--agent <name>...]");
    expect(usage).toContain("[--interactive|--yes|--dry-run] [--json]");
    expect(usage).not.toContain("agents:");
  });

  test("falls back to a one-line usage for a command without a usage block", () => {
    expect(helpUsage("no-such-command")).toBe("usage: skillmux no-such-command");
  });
});

describe("skillmux init argument errors", () => {
  test("an unsupported agent fails before any plan is printed", async () => {
    const { code, stdout, stderr } = await init("--vault", "/nonexistent-vault", "--agent", "bogus", "--yes");
    expect(code).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toContain('unsupported agent "bogus"');
  });

  test("a missing option value names what is missing, then shows the usage", async () => {
    for (const [flag, problem] of [
      ["--agent", "--agent requires a name"],
      ["--vault", "--vault requires a path"],
      ["--core", "--core requires a skill_id"],
    ] as const) {
      const { code, stderr } = await init(flag);
      expect(code).toBe(2);
      const lines = stderr.trim().split("\n");
      expect(lines[0]).toBe(`error: ${problem}`);
      expect(lines[1]).toBe("usage:");
      expect(lines[2]).toStartWith("  skillmux init");
    }
  });

  test("--scope points at project init", async () => {
    const { code, stderr } = await init("--scope", "project");
    expect(code).toBe(2);
    expect(stderr).toContain('"skillmux project init [path]"');
    expect(stderr).not.toContain("--core");
  });
});
