import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { documentedFlags } from "../src/command-help";
import { COMMANDS } from "../src/command-registry";
import { flagsFor, generateCompletions } from "../src/completions";

async function sh(cmd: string[]): Promise<string> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out.trim();
}

function script(shell: "bash" | "zsh" | "fish"): string {
  const dir = mkdtempSync(join(tmpdir(), "skillmux-comp-"));
  const path = join(dir, `completion.${shell}`);
  writeFileSync(path, generateCompletions(shell));
  return path;
}

describe("flagsFor", () => {
  test("every command offers the universal flags", () => {
    for (const { name } of COMMANDS) {
      for (const flag of ["--json", "--verbose", "--no-color", "--help"]) {
        expect(flagsFor(name)).toContain(flag);
      }
    }
  });

  test("--context and --server only appear where a command can use them", () => {
    for (const { name, contextSupport } of COMMANDS) {
      const flags = flagsFor(name);
      if (contextSupport === "remote-capable") {
        expect(flags).toEqual(expect.arrayContaining(["--context", "--server", "--allow-insecure"]));
      } else if (!documentedFlags(name).includes("--server")) {
        expect(flags).not.toContain("--context");
        expect(flags).not.toContain("--server");
      }
    }
  });

  test("a command's documented flags are all offered, except deprecated ones", () => {
    for (const { name } of COMMANDS) {
      for (const flag of documentedFlags(name)) {
        if (flag === "--format" || flag === "--target") continue;
        expect(flagsFor(name)).toContain(flag);
      }
    }
  });

  test("deprecated flags are not suggested", () => {
    expect(flagsFor("scan")).not.toContain("--format");
  });
});

describe("generated scripts offer flags after a command", () => {
  test("every shell script names each command's flags", () => {
    for (const shell of ["bash", "zsh", "fish"] as const) {
      const text = generateCompletions(shell);
      for (const { name } of COMMANDS) {
        for (const flag of flagsFor(name)) {
          const bare = shell === "fish" ? ` -l ${flag.slice(2)}` : flag;
          expect(text).toContain(bare);
        }
      }
    }
  });

  test.skipIf(!Bun.which("bash"))("bash completes flags for the command being typed", async () => {
    const run = (words: string) =>
      sh([
        "bash",
        "-c",
        `source ${script("bash")}; COMP_WORDS=(${words}); COMP_CWORD=$((\${#COMP_WORDS[@]}-1)); COMPREPLY=(); _skillmux_completions; echo "\${COMPREPLY[*]}"`,
      ]);
    expect((await run("skillmux install --f")).split(" ").sort()).toEqual(["--fail-on", "--force"]);
    expect(await run("skillmux doctor --no-c")).toBe("--no-color");
    expect((await run("skillmux doctor --con")).split(" ")).toEqual(["--context"]);
    // scan is local-only: no --context offered
    expect(await run("skillmux scan --con")).toBe("");
  });

  test.skipIf(!Bun.which("fish"))("fish completes flags for the command being typed", async () => {
    const run = (line: string) =>
      sh(["fish", "-c", `source ${script("fish")}; complete -C "${line}"`]).then((out) =>
        out.split("\n").filter(Boolean).map((l) => l.split("\t")[0]!),
      );
    expect((await run("skillmux install --f")).sort()).toEqual(["--fail-on", "--force"]);
    expect(await run("skillmux doctor --no-c")).toEqual(["--no-color"]);
    expect(await run("skillmux doctor --con")).toEqual(["--context"]);
    expect(await run("skillmux scan --con")).toEqual([]);
    // declared in two places (hand-written and global): must not appear twice
    expect(await run("skillmux init --js")).toEqual(["--json"]);
  });

  test.skipIf(!Bun.which("zsh"))("zsh completes flags for the command being typed", async () => {
    // The generated file ends by calling _skillmux itself, so drop that line and
    // call it ourselves with the words under test, capturing what it would add.
    const dir = mkdtempSync(join(tmpdir(), "skillmux-zsh-"));
    const body = generateCompletions("zsh").trimEnd().split("\n").slice(0, -1).join("\n");
    writeFileSync(join(dir, "z.zsh"), body);
    const run = (words: string) =>
      sh([
        "zsh",
        "-c",
        `compadd(){ shift; print -r -- "$@" }; source ${join(dir, "z.zsh")}; words=(${words}); CURRENT=\${#words}; _skillmux`,
      ]).then((out) => out.split(" ").filter(Boolean));

    const scan = await run("skillmux scan --");
    expect(scan).toEqual(expect.arrayContaining(["--no-color", "--fail-on"]));
    // scan is local-only: no --context offered
    expect(scan).not.toContain("--context");
    expect(await run("skillmux doctor --")).toContain("--context");
  });
});
